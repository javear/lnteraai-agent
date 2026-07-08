// Agent-invoked "remember this" tool — the intentional path for chat-as-knowledge (per the feature's
// design: we do NOT passively auto-embed every chat message, only what the agent judges worth saving).
// Runs synchronously (not via the async document-upload pipeline) since it's already plain text and
// short enough that one extra LLM+embedding round-trip inside the tool call is an acceptable cost —
// still persists a document row + Storage blob so it survives a 90-day inactivity graph eviction like
// any uploaded document (see sweep-knowledge-eviction.ts).
import { randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { checkQuota, recordUsageDelta } from '../../integrations/knowledge/quota';
import {
  createKnowledgeDocument,
  storagePathFor,
  uploadKnowledgeFile,
  updateKnowledgeDocumentStatus,
} from '../../integrations/knowledge/documents-repo';
import { chunkText } from '../../integrations/knowledge/chunk';
import { embedTexts } from '../../integrations/embeddings/qwen-embeddings';
import { extractEntitiesAndRelationships } from '../../integrations/knowledge/extract-entities';
import { ingestChunks, type ChunkToIngest } from '../../integrations/knowledge/graph-write';
import { ensureGraphFresh } from '../../integrations/knowledge/eviction';

const paramsSchema = z.object({
  fact: z.string().min(1).max(4000),
});

export const saveKnowledgeTool = createTool({
  id: 'save-knowledge',
  strict: false,
  description:
    'Save a durable fact, preference, or decision from this conversation to the business\'s knowledge base, so it can be recalled later via search-knowledge. Use only when the user shares something worth remembering long-term (a policy, a preference, a decision) — not for routine chat. Pass fact: the fact in your own words, self-contained (not "yes" or a pronoun-only fragment).',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { fact: 'We offer free returns within 30 days for unopened items.' } }],
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, message: 'Tell me the specific fact to save.' };
    }

    const fact = parsed.data.fact.trim();
    const buffer = Buffer.from(fact, 'utf-8');

    try {
      await checkQuota(tenantId, buffer.length);
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Knowledge base limit reached.' };
    }

    // Best-effort: if this tenant's graph was evicted for inactivity, re-queue their other documents
    // in the background — this fact still gets saved into a freshly-created graph either way.
    void ensureGraphFresh(tenantId).catch(() => undefined);

    const documentId = randomUUID();
    const filename = `chat-note-${documentId}.txt`;
    const storagePath = storagePathFor(tenantId, documentId, filename);

    try {
      await uploadKnowledgeFile(storagePath, buffer, 'text/plain');
      const document = await createKnowledgeDocument({
        tenant_id: tenantId,
        filename,
        mime_type: 'text/plain',
        byte_size: buffer.length,
        storage_path: storagePath,
        source_type: 'chat',
      });
      await recordUsageDelta(tenantId, buffer.length);

      const chunks = chunkText(fact);
      const embeddings = await embedTexts(chunks);
      const toIngest: ChunkToIngest[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const extracted = await extractEntitiesAndRelationships(tenantId, chunks[i]);
        toIngest.push({
          id: randomUUID(),
          text: chunks[i],
          embedding: embeddings[i],
          documentId: document.id,
          sourceType: 'chat',
          chunkIndex: i,
          extracted,
        });
      }
      await ingestChunks(tenantId, toIngest);
      await updateKnowledgeDocumentStatus(document.id, 'ready');

      return { success: true, message: 'Saved to the knowledge base.' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Could not save that.' };
    }
  },
});
