// Runs hybrid search (full-text + vector RRF) over the tenant's catalog and bands the top hit by
// COSINE semantic similarity (0..1) against the tenant thresholds. RRF is ranking-only; the band
// decision uses semantic_similarity so an FTS-only hit can't masquerade as a strong match.
import { getSupabase } from '../shared/supabase';
import { embedText, toPgVectorLiteral } from '../embeddings/qwen-embeddings';

export interface MatchCandidate {
  productId: string;
  title: string;
  semanticSimilarity: number | null;
  rrfScore: number;
}

export type MatchBand = 'high' | 'medium' | 'new';

export interface MatchResult {
  band: MatchBand;
  top: MatchCandidate | null;
  candidates: MatchCandidate[];
}

interface HybridRow {
  product_id: string;
  title: string;
  semantic_similarity: number | null;
  fts_rank: number | null;
  semantic_rank: number | null;
  rrf_score: number;
}

export async function matchExternalProduct(args: {
  tenantId: string;
  queryText: string;
  highThreshold: number;
  mediumThreshold: number;
  matchCount?: number;
}): Promise<MatchResult> {
  const queryText = (args.queryText || '').trim();
  if (!queryText) return { band: 'new', top: null, candidates: [] };

  const embedding = await embedText(queryText);
  const { data, error } = await getSupabase().rpc('hybrid_search_products', {
    p_tenant_id: args.tenantId,
    p_query_text: queryText,
    p_query_embedding: toPgVectorLiteral(embedding),
    p_match_count: args.matchCount ?? 5,
  });
  if (error) throw new Error(`hybrid_search_products failed: ${error.message}`);

  const candidates: MatchCandidate[] = ((data as HybridRow[] | null) ?? []).map((r) => ({
    productId: r.product_id,
    title: r.title,
    semanticSimilarity: r.semantic_similarity == null ? null : Number(r.semantic_similarity),
    rrfScore: Number(r.rrf_score),
  }));

  const top = candidates[0] ?? null;
  const sim = top?.semanticSimilarity ?? null;
  let band: MatchBand = 'new';
  if (sim != null && sim >= args.highThreshold) band = 'high';
  else if (sim != null && sim >= args.mediumThreshold) band = 'medium';
  return { band, top, candidates };
}
