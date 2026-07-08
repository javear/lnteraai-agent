// Retrieval half of GraphRAG: vector search over Chunk nodes, then 1-hop graph traversal from the
// matched chunks' mentioned entities for connected context a flat vector search would miss.
import { getTenantGraph } from './falkordb-client';

export interface RetrievedChunk {
  id: string;
  text: string;
  documentId: string;
  sourceType: string;
  score: number;
}

export interface RelatedEntity {
  name: string;
  type: string;
}

export interface KnowledgeSearchResult {
  chunks: RetrievedChunk[];
  relatedEntities: RelatedEntity[];
}

interface QueryRow {
  id?: string;
  text?: string;
  documentId?: string;
  sourceType?: string;
  score?: number;
  name?: string;
  type?: string;
}

export async function searchTenantKnowledge(
  tenantId: string,
  queryEmbedding: number[],
  topK = 5,
): Promise<KnowledgeSearchResult> {
  const graph = await getTenantGraph(tenantId);

  // `score` from db.idx.vector.queryNodes is a DISTANCE (0 = identical), not a similarity, despite
  // FalkorDB's own docs example showing `ORDER BY score DESC` — confirmed empirically: a self-query
  // returns score=0 and an unrelated chunk returns a much larger score. Smaller is better.
  const knn = await graph.query<QueryRow>(
    `CALL db.idx.vector.queryNodes('Chunk', 'embedding', $k, vecf32($embedding)) YIELD node, score
     RETURN node.id AS id, node.text AS text, node.documentId AS documentId, node.sourceType AS sourceType, score
     ORDER BY score ASC`,
    { params: { k: topK, embedding: queryEmbedding } },
  );
  const chunks: RetrievedChunk[] = (knn.data ?? []).map((row) => ({
    id: String(row.id),
    text: String(row.text),
    documentId: String(row.documentId),
    sourceType: String(row.sourceType),
    score: Number(row.score),
  }));
  if (chunks.length === 0) return { chunks: [], relatedEntities: [] };

  // 1-hop enrichment: entities directly mentioned by the matched chunks — this is the "graph" half
  // of GraphRAG, surfacing connected context a pure vector search over chunk text alone would miss.
  const enrich = await graph.query<QueryRow>(
    `MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)
     WHERE c.id IN $chunkIds
     RETURN DISTINCT e.name AS name, e.type AS type`,
    { params: { chunkIds: chunks.map((c) => c.id) } },
  );
  const relatedEntities: RelatedEntity[] = (enrich.data ?? []).map((row) => ({
    name: String(row.name),
    type: String(row.type),
  }));

  return { chunks, relatedEntities };
}

export interface GraphSnapshot {
  nodes: Array<{ id: string; label: 'Chunk' | 'Entity'; caption: string; type?: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
}

/** Capped snapshot of a tenant's whole graph for the Knowledge page's node-link visualization. */
export async function getTenantGraphSnapshot(tenantId: string, maxNodes = 500): Promise<GraphSnapshot> {
  const graph = await getTenantGraph(tenantId);

  const entities = await graph.query<{ name: string; type: string }>(
    `MATCH (e:Entity) RETURN e.name AS name, e.type AS type LIMIT $max`,
    { params: { max: maxNodes } },
  );
  const nodes: GraphSnapshot['nodes'] = (entities.data ?? []).map((row) => ({
    id: `entity:${row.name}`,
    label: 'Entity',
    caption: String(row.name),
    type: String(row.type),
  }));

  const rels = await graph.query<{ from: string; to: string; type: string }>(
    `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.name AS from, b.name AS to, r.type AS type LIMIT $max`,
    { params: { max: maxNodes * 2 } },
  );
  const edges: GraphSnapshot['edges'] = (rels.data ?? []).map((row) => ({
    source: `entity:${row.from}`,
    target: `entity:${row.to}`,
    label: String(row.type),
  }));

  return { nodes, edges };
}
