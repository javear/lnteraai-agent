// Parses an uploaded knowledge document, chunks + embeds + extracts its graph, and writes it into
// the tenant's FalkorDB graph. Triggered by the upload route (POST /svc/v1/knowledge/documents) and
// re-triggered per-document by the eviction sweep's rebuild-on-return path (see
// sweep-knowledge-eviction.ts) — both just emit the same event.
import { randomUUID } from 'node:crypto';
import { inngest } from '../client';
import {
  getKnowledgeDocument,
  updateKnowledgeDocumentStatus,
  downloadKnowledgeFile,
} from '../../integrations/knowledge/documents-repo';
import { extractDocumentText } from '../../integrations/knowledge/parsers';
import { extractImageText } from '../../integrations/knowledge/image-ocr';
import { chunkText } from '../../integrations/knowledge/chunk';
import { embedTexts } from '../../integrations/embeddings/qwen-embeddings';
import { extractEntitiesAndRelationships } from '../../integrations/knowledge/extract-entities';
import { ingestChunks, type ChunkToIngest } from '../../integrations/knowledge/graph-write';

interface IngestDocumentEventData {
  tenantId: string;
  documentId: string;
}

export const ingestDocumentFn = inngest.createFunction(
  {
    id: 'ingest-knowledge-document',
    // Serialize per tenant — concurrent ingestion for the same tenant graph would race MERGE-based
    // entity dedup (two chunks creating the "same" entity as separate nodes if interleaved). Global
    // limit stays under the plan's per-function cap of 5 (same margin run-insight.ts keeps).
    concurrency: [{ limit: 4 }, { key: 'event.data.tenantId', limit: 1 }],
    retries: 2,
    triggers: [{ event: 'knowledge/document.uploaded' }],
  },
  async ({ event, step }) => {
    const { tenantId, documentId } = event.data as IngestDocumentEventData;

    const doc = await step.run('load-document', async () => {
      const d = await getKnowledgeDocument(tenantId, documentId);
      if (!d) throw new Error(`Knowledge document ${documentId} not found for tenant ${tenantId}.`);
      return d;
    });

    await step.run('mark-processing', () => updateKnowledgeDocumentStatus(documentId, 'processing'));

    try {
      const text = await step.run('parse', async () => {
        const buffer = await downloadKnowledgeFile(doc.storage_path);
        // Images have no text to parse — describe/OCR them via a vision-capable model instead, then
        // feed the result into the same chunk/embed/extract pipeline as any other document.
        if (doc.mime_type.startsWith('image/')) return extractImageText(tenantId, buffer, doc.mime_type);
        return extractDocumentText(buffer, doc.mime_type, doc.filename);
      });

      const chunks = chunkText(text);
      if (chunks.length === 0) {
        await step.run('mark-ready-empty', () => updateKnowledgeDocumentStatus(documentId, 'ready'));
        return { chunkCount: 0 };
      }

      const embeddings = await step.run('embed', () => embedTexts(chunks));

      const toIngest: ChunkToIngest[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const extracted = await step.run(`extract-${i}`, () =>
          extractEntitiesAndRelationships(tenantId, chunks[i]),
        );
        toIngest.push({
          id: randomUUID(),
          text: chunks[i],
          embedding: embeddings[i],
          documentId,
          sourceType: doc.source_type,
          chunkIndex: i,
          extracted,
        });
      }

      await step.run('write-graph', () => ingestChunks(tenantId, toIngest));
      await step.run('mark-ready', () => updateKnowledgeDocumentStatus(documentId, 'ready'));
      return { chunkCount: chunks.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run('mark-failed', () => updateKnowledgeDocumentStatus(documentId, 'failed', message));
      throw err;
    }
  },
);
