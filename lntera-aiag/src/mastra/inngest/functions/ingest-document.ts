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
  uploadKnowledgeFile,
  deleteKnowledgeFile,
  extractedTextPathFor,
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

// A large document (up to the ~10MB/tenant cap) can chunk into thousands of pieces. One Inngest STEP
// per chunk means every subsequent step invocation has to replay/resend every prior step's memoized
// result — for a several-thousand-chunk document that's a request payload (and replay cost) that
// grows without bound, and was the real cause of repeated "Application failed to respond" 502s /
// container memory pressure during ingestion (timeouts on the LLM calls themselves, added separately,
// don't help this — the problem is step COUNT, not any single call hanging). Processing chunks in
// fixed-size batches per step keeps both the per-step payload size and the LLM-call wall-clock time
// bounded regardless of document size.
const CHUNK_BATCH_SIZE = 8;

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

    // Where the full chunk list lives between the 'parse' step and the batch loop — NOT threaded
    // through Inngest's own step-return-value memoization. A large document's extracted text can be
    // tens of MB; returning that (or the resulting chunk array, similar total size) directly from a
    // step means Inngest resends/replays that whole payload on EVERY subsequent step of the same run.
    // Uploading it to storage and returning only a small { chunkCount, chunksPath } reference instead
    // decouples the large data from Inngest's replay mechanism entirely — each batch step then does a
    // normal, independent storage download (ordinary per-step memory, reclaimed when the step ends),
    // not a payload that compounds across the whole run.
    const chunksPath = `${tenantId}/${documentId}/chunks.json`;

    try {
      const parsed = await step.run('parse', async () => {
        // A PDF's text may already have been extracted client-side, in the user's own browser, at
        // upload time (see pdf-extract.ts / the upload route) — when that companion file exists, skip
        // downloading + re-parsing the raw PDF on the server entirely. This is the primary path now;
        // falling through to server-side parsing below is the fallback for older documents uploaded
        // before this existed, non-PDF files, or if the client-side extraction failed for any reason.
        let text: string;
        try {
          text = (await downloadKnowledgeFile(extractedTextPathFor(tenantId, documentId))).toString('utf8');
        } catch {
          const buffer = await downloadKnowledgeFile(doc.storage_path);
          // Images have no text to parse — describe/OCR them via a vision-capable model instead, then
          // feed the result into the same chunk/embed/extract pipeline as any other document. PDF
          // extraction runs in an isolated child process (see pdf-isolated-parse.ts) — unlike every
          // other format, it can blow past what the file's byte size suggests and previously crashed
          // the whole container.
          text = doc.mime_type.startsWith('image/')
            ? await extractImageText(tenantId, buffer, doc.mime_type)
            : await extractDocumentText(buffer, doc.mime_type, doc.filename);
        }

        const chunks = chunkText(text);
        if (chunks.length === 0) return { chunkCount: 0 };

        await uploadKnowledgeFile(chunksPath, Buffer.from(JSON.stringify(chunks), 'utf8'), 'application/json');
        return { chunkCount: chunks.length };
      });

      if (parsed.chunkCount === 0) {
        await step.run('mark-ready-empty', () => updateKnowledgeDocumentStatus(documentId, 'ready'));
        return { chunkCount: 0 };
      }

      const toIngest: ChunkToIngest[] = [];
      for (let batchStart = 0; batchStart < parsed.chunkCount; batchStart += CHUNK_BATCH_SIZE) {
        const batchResults = await step.run(`process-batch-${batchStart}`, async () => {
          const allChunks = JSON.parse((await downloadKnowledgeFile(chunksPath)).toString('utf8')) as string[];
          const batchChunks = allChunks.slice(batchStart, batchStart + CHUNK_BATCH_SIZE);
          const batchEmbeddings = await embedTexts(batchChunks);
          const results: ChunkToIngest[] = [];
          for (let j = 0; j < batchChunks.length; j++) {
            const extracted = await extractEntitiesAndRelationships(tenantId, batchChunks[j]);
            results.push({
              id: randomUUID(),
              text: batchChunks[j],
              embedding: batchEmbeddings[j],
              documentId,
              sourceType: doc.source_type,
              chunkIndex: batchStart + j,
              extracted,
            });
          }
          return results;
        });
        toIngest.push(...batchResults);
      }

      await step.run('write-graph', () => ingestChunks(tenantId, toIngest));
      await step.run('cleanup-chunks-file', () => deleteKnowledgeFile(chunksPath).catch(() => undefined));
      await step.run('mark-ready', () => updateKnowledgeDocumentStatus(documentId, 'ready'));
      return { chunkCount: parsed.chunkCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run('mark-failed', () => updateKnowledgeDocumentStatus(documentId, 'failed', message));
      await deleteKnowledgeFile(chunksPath).catch(() => undefined);
      throw err;
    }
  },
);
