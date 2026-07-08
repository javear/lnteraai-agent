// Writes chunks/entities/relationships into a tenant's FalkorDB graph.
//
// Schema per tenant graph:
//   (:Chunk {id, text, embedding, documentId, sourceType, chunkIndex})  -- vector-indexed on embedding
//   (:Entity {name, type})                                              -- deduped by (name, type)
//   (:Chunk)-[:MENTIONS]->(:Entity)
//   (:Entity)-[:RELATES_TO {type}]->(:Entity)
import { getTenantGraph } from './falkordb-client';
import { EMBEDDING_DIM } from '../embeddings/qwen-embeddings';
import type { ExtractedGraph } from './extract-entities';

export interface ChunkToIngest {
  id: string;
  text: string;
  embedding: number[];
  documentId: string;
  sourceType: 'document' | 'chat';
  chunkIndex: number;
  extracted: ExtractedGraph;
}

/** Idempotent — FalkorDB errors when the index already exists, which we treat as success. */
async function ensureChunkVectorIndex(tenantId: string): Promise<void> {
  const graph = await getTenantGraph(tenantId);
  try {
    await graph.createNodeVectorIndex('Chunk', EMBEDDING_DIM, 'cosine', 'embedding');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already indexed|already exists/i.test(msg)) throw err;
  }
}

export async function ingestChunks(tenantId: string, chunks: ChunkToIngest[]): Promise<void> {
  if (chunks.length === 0) return;
  await ensureChunkVectorIndex(tenantId);
  const graph = await getTenantGraph(tenantId);

  for (const chunk of chunks) {
    await graph.query(
      `CREATE (c:Chunk {
         id: $id, text: $text, embedding: vecf32($embedding),
         documentId: $documentId, sourceType: $sourceType, chunkIndex: $chunkIndex
       })`,
      {
        params: {
          id: chunk.id,
          text: chunk.text,
          embedding: chunk.embedding,
          documentId: chunk.documentId,
          sourceType: chunk.sourceType,
          chunkIndex: chunk.chunkIndex,
        },
      },
    );

    for (const entity of chunk.extracted.entities) {
      await graph.query(
        `MATCH (c:Chunk {id: $chunkId})
         MERGE (e:Entity {name: $name, type: $type})
         MERGE (c)-[:MENTIONS]->(e)`,
        { params: { chunkId: chunk.id, name: entity.name, type: entity.type } },
      );
    }

    for (const rel of chunk.extracted.relationships) {
      await graph.query(
        `MATCH (a:Entity {name: $from}), (b:Entity {name: $to})
         MERGE (a)-[:RELATES_TO {type: $type}]->(b)`,
        { params: { from: rel.from, to: rel.to, type: rel.type } },
      );
    }
  }
}

/** Removes one document's chunks. Entities/relationships they contributed are left in place — they
 *  may still be mentioned by other documents, and orphan cleanup isn't worth the extra query cost
 *  for a 10MB-capped graph. */
export async function deleteDocumentFromGraph(tenantId: string, documentId: string): Promise<void> {
  const graph = await getTenantGraph(tenantId);
  await graph.query(`MATCH (c:Chunk {documentId: $documentId}) DETACH DELETE c`, {
    params: { documentId },
  });
}
