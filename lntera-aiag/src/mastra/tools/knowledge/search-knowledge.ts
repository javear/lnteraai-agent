// GraphRAG retrieval: embeds the query, vector-searches the tenant's FalkorDB Chunk nodes, then
// 1-hop-enriches with directly connected entities — the graph half of GraphRAG, not just flat search.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { embedText } from '../../integrations/embeddings/qwen-embeddings';
import { searchTenantKnowledge } from '../../integrations/knowledge/graph-read';
import { ensureGraphFresh } from '../../integrations/knowledge/eviction';
import { touchActivity } from '../../integrations/knowledge/quota';

const paramsSchema = z.object({
  query: z.string().min(1),
});

export const searchKnowledgeTool = createTool({
  id: 'search-knowledge',
  strict: false,
  description:
    "Search this business's uploaded documents and previously saved knowledge for relevant context. Use when the user asks something their own docs, spreadsheets, or past conversations might answer. Pass query: a short search phrase (not the user's whole message).",
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { query: 'refund policy' } }, { input: { query: 'Q3 revenue by region' } }],
  outputSchema: z.object({
    // No raw similarity/distance number exposed here — results are already ranked best-first;
    // an unlabeled score risks the agent reasoning about it backwards (see graph-read.ts).
    results: z.array(z.object({ text: z.string(), sourceType: z.string() })),
    relatedEntities: z.array(z.object({ name: z.string(), type: z.string() })),
    notice: z.string().optional(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('query is required — a short search phrase.');
    }

    void touchActivity(tenantId).catch(() => undefined);

    const rebuilding = await ensureGraphFresh(tenantId);
    if (rebuilding) {
      return {
        results: [],
        relatedEntities: [],
        notice: 'The knowledge base was paused after a long period of inactivity and is now rebuilding — try again in a few minutes.',
      };
    }

    const embedding = await embedText(parsed.data.query);
    const { chunks, relatedEntities } = await searchTenantKnowledge(tenantId, embedding, 5);

    return {
      results: chunks.map((c) => ({ text: c.text, sourceType: c.sourceType })),
      relatedEntities,
    };
  },
});
