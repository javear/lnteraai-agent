// Router: given a marketplace product detail, resolve sync prefs, run hybrid match, and route by
// similarity band → auto-map / suggest / auto-create / leave unmatched. Writes an idempotent
// product_mappings row (unique on connection+external id) and returns a DETERMINISTIC notice
// descriptor (no LLM) the caller renders + dispatches (webhook = now, resync = end-of-run batch).
//
// Decided links are never silently re-routed: a re-ingest only refreshes score/name, and when WE
// created the internal product from the listing we refresh that catalog row (stock/price/title truth).
import type { MarketplaceConnection } from '../shared/types';
import type { NormalizedProductDetail } from '../shared/products';
import { resolveSyncPrefs } from '../shared/sync-prefs';
import { buildEmbeddingText } from '../embeddings/product-embedding-text';
import { matchExternalProduct, type MatchBand } from './match-service';
import { normalizedToTenantProduct } from './product-mapper';
import { upsertTenantProductWithEmbedding } from './tenant-products-repo';
import {
  getMappingByExternal,
  getMappingById,
  isDecidedStatus,
  updateMapping,
  upsertMapping,
  type ProductMappingMatchedBy,
  type ProductMappingRow,
  type ProductMappingStatus,
} from './product-mappings-repo';

export type IngestDecision =
  | 'auto_mapped'
  | 'suggest_map'
  | 'suggest_medium'
  | 'auto_created'
  | 'unmatched'
  | 'already_decided';

/** Deterministic, token-free descriptor the notifier renders into a templated prompt. */
export interface ProductSyncNotice {
  kind: 'new_product' | 'suggest_map' | 'low_match' | 'auto_created_fyi' | 'auto_mapped_fyi';
  linkId: string;
  platform: string;
  externalProductId: string;
  externalProductName: string;
  matchTitle?: string | null;
  internalProductId?: string | null;
  score?: number | null;
}

export interface IngestResult {
  decision: IngestDecision;
  mappingId: string;
  internalProductId: string | null;
  band: MatchBand | null;
  score: number | null;
  /** null when no user prompt is warranted (e.g. a non-title-changing re-ingest). */
  notice: ProductSyncNotice | null;
}

export async function ingestMarketplaceProduct(args: {
  tenantId: string;
  connection: MarketplaceConnection;
  detail: NormalizedProductDetail;
  trigger: 'resync' | 'webhook' | 'manual';
  eventKey?: string | null;
}): Promise<IngestResult> {
  const { tenantId, connection, detail } = args;
  const platform = connection.platform;
  const externalProductId = detail.productId;
  const externalProductName = detail.title;
  const eventKey = args.eventKey ?? null;

  const prefs = await resolveSyncPrefs(tenantId, connection.id);
  const queryText = buildEmbeddingText(detail, {});
  const existing = await getMappingByExternal(connection.id, externalProductId);

  // ---- Re-ingest of a settled link: refresh only, never re-route. -------------------------------
  if (existing && isDecidedStatus(existing.status)) {
    const titleChanged = (existing.external_product_name ?? '') !== externalProductName;
    let score = existing.match_score;
    if (titleChanged) {
      const match = await matchExternalProduct({
        tenantId,
        queryText,
        highThreshold: prefs.highThreshold,
        mediumThreshold: prefs.mediumThreshold,
      });
      score = match.top?.semanticSimilarity ?? existing.match_score;
    }
    // Marketplace is the source of truth for products we created from it — refresh the catalog row
    // (cheap: the repo skips re-embedding when the source text is unchanged).
    if (existing.status === 'new_created' && existing.internal_product_id) {
      await upsertTenantProductWithEmbedding(
        normalizedToTenantProduct(detail, { tenantId, connectionId: connection.id }),
        { existingProductId: existing.internal_product_id },
      );
    }
    await updateMapping(existing.id, {
      externalProductName,
      matchScore: score,
      lastEventKey: eventKey ?? existing.last_event_key,
      touchMatchedAt: true,
    });
    return {
      decision: 'already_decided',
      mappingId: existing.id,
      internalProductId: existing.internal_product_id,
      band: null,
      score: score ?? null,
      notice: null,
    };
  }

  // ---- Fresh decision (no mapping, or an undecided suggested/unmatched row). ---------------------
  const match = await matchExternalProduct({
    tenantId,
    queryText,
    highThreshold: prefs.highThreshold,
    mediumThreshold: prefs.mediumThreshold,
  });
  const top = match.top;
  const score = top?.semanticSimilarity ?? null;

  const persist = async (m: {
    status: ProductMappingStatus;
    matchedBy: ProductMappingMatchedBy;
    internalProductId: string | null;
    raw: Record<string, unknown> | null;
  }): Promise<ProductMappingRow> => {
    if (existing) {
      const updated = await updateMapping(existing.id, {
        status: m.status,
        matchedBy: m.matchedBy,
        internalProductId: m.internalProductId,
        externalProductName,
        matchScore: score,
        raw: m.raw,
        lastEventKey: eventKey,
        touchMatchedAt: true,
      });
      if (updated) return updated;
      const reread = await getMappingById(existing.id);
      if (reread) return reread;
    }
    return upsertMapping({
      tenantId,
      connectionId: connection.id,
      platform,
      externalProductId,
      externalProductName,
      matchScore: score,
      status: m.status,
      matchedBy: m.matchedBy,
      internalProductId: m.internalProductId,
      raw: m.raw,
      lastEventKey: eventKey,
    });
  };

  const finish = (
    decision: IngestDecision,
    row: ProductMappingRow,
    internalProductId: string | null,
    notice: Omit<ProductSyncNotice, 'platform' | 'externalProductId' | 'externalProductName' | 'linkId'> | null,
  ): IngestResult => ({
    decision,
    mappingId: row.id,
    internalProductId,
    band: match.band,
    score,
    notice: notice
      ? { ...notice, linkId: row.id, platform, externalProductId, externalProductName }
      : null,
  });

  // HIGH confidence ------------------------------------------------------------------------------
  if (match.band === 'high' && top) {
    if (prefs.autoMapHighConfidence) {
      const row = await persist({
        status: 'auto_mapped',
        matchedBy: 'auto_map',
        internalProductId: top.productId,
        raw: { suggestedProductId: top.productId, rrfScore: top.rrfScore },
      });
      return finish('auto_mapped', row, top.productId, {
        kind: 'auto_mapped_fyi',
        matchTitle: top.title,
        internalProductId: top.productId,
        score,
      });
    }
    const row = await persist({
      status: 'suggested',
      matchedBy: 'system',
      internalProductId: null,
      raw: { suggestedProductId: top.productId, rrfScore: top.rrfScore },
    });
    return finish('suggest_map', row, null, {
      kind: 'suggest_map',
      matchTitle: top.title,
      internalProductId: top.productId,
      score,
    });
  }

  // MEDIUM confidence (always ask) ----------------------------------------------------------------
  if (match.band === 'medium' && top) {
    const row = await persist({
      status: 'suggested',
      matchedBy: 'system',
      internalProductId: null,
      raw: { suggestedProductId: top.productId, rrfScore: top.rrfScore },
    });
    return finish('suggest_medium', row, null, {
      kind: 'low_match',
      matchTitle: top.title,
      internalProductId: top.productId,
      score,
    });
  }

  // NEW (no confident hit) ------------------------------------------------------------------------
  if (prefs.autoCreateNew) {
    const { productId } = await upsertTenantProductWithEmbedding(
      normalizedToTenantProduct(detail, { tenantId, connectionId: connection.id }),
      { existingProductId: existing?.internal_product_id ?? null },
    );
    const row = await persist({
      status: 'new_created',
      matchedBy: 'auto_create',
      internalProductId: productId,
      raw: null,
    });
    return finish('auto_created', row, productId, {
      kind: 'auto_created_fyi',
      internalProductId: productId,
      score,
    });
  }

  const row = await persist({ status: 'unmatched', matchedBy: 'system', internalProductId: null, raw: null });
  return finish('unmatched', row, null, { kind: 'new_product', score });
}
