// Agent-callable: search the public internet (via Parallel.ai) for context beyond the tenant's own
// knowledge base — news, market data, competitor info, anything not in their uploaded documents.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { parallelSearch, getParallelApiKey } from '../../integrations/research/parallel-client';

// Same rationale as truncateForAgent in studio/tools.ts: cap what reaches the LLM per call so one
// broad search doesn't burn a big share of the turn budget.
const MAX_EXCERPT_CHARS = 600;
const MAX_RESULTS = 8;

const paramsSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

export const webSearchTool = createTool({
  id: 'web-search',
  strict: false,
  description:
    'Search the public internet for information relevant to the query — news, market data, prices, general facts. Use when the user asks something that needs current or external information, not just their own business data. Pass query: a short, specific search phrase (3-6 words works best).',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { query: 'coffee bean price forecast 2027' } }],
  outputSchema: z.object({
    results: z.array(
      z.object({ url: z.string(), title: z.string(), publishDate: z.string().nullable(), excerpt: z.string() }),
    ),
    notice: z.string().optional(),
  }),
  execute: async (input, context) => {
    requireTenantContext(context); // tenant-gated tool, even though the search itself isn't tenant-scoped
    if (!getParallelApiKey()) {
      return { results: [], notice: 'Web search is not configured on this server.' };
    }
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) throw new Error('query is required — a short search phrase.');

    const results = await parallelSearch({
      searchQueries: [parsed.data.query],
      maxResults: parsed.data.maxResults ?? MAX_RESULTS,
    });

    return {
      results: results.map((r) => ({
        url: r.url,
        title: r.title,
        publishDate: r.publishDate,
        excerpt: truncate(r.excerpts.join(' '), MAX_EXCERPT_CHARS),
      })),
    };
  },
});

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
