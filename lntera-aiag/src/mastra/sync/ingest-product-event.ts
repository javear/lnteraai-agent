// Webhook → product ingest bridge. Extracts the product id from a Shopee/TikTok product event,
// dedupes re-delivered events (by event key vs the mapping's last_event_key), fetches fresh detail,
// runs the ingest router (re-scores/refreshes), and fires the deterministic (no-LLM) prompt.
import type { MarketplaceConnection, Platform } from '../integrations/shared/types';
import { logErrorBrief } from '../logger/compact-error';
import { fetchNormalizedProductDetail } from '../integrations/shared/product-detail-fetch';
import { ingestMarketplaceProduct } from '../integrations/products/ingest-marketplace-product';
import { getMappingByExternal } from '../integrations/products/product-mappings-repo';
import { isDuplicateEvent } from './product-sync-dedup';
import { notifyProductSyncDecision } from './product-sync-notifier';
import { reconcileAndPropagateFromMarketplace } from './reconcile-from-marketplace';

export interface IngestProductEventResult {
  status: 'ingested' | 'duplicate' | 'no_product_id' | 'detail_not_found' | 'error';
  mappingId?: string;
  decision?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function extractProductId(platform: Platform, payload: unknown): string | null {
  const obj = asRecord(payload);
  const data = asRecord(obj.data ?? obj);
  const candidates =
    platform === 'tiktok'
      ? [data.product_id, data.productId, obj.product_id]
      : [data.item_id, data.itemId, obj.item_id, data.product_id];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return null;
}

/** Stable key for retry-dedup. Only built when the payload carries a timestamp, so legitimate later
 *  edits (new timestamp) are NOT mistaken for retries — when absent we simply don't dedup. */
function buildEventKey(platform: Platform, code: string, productId: string, payload: unknown): string | null {
  const obj = asRecord(payload);
  const data = asRecord(obj.data ?? obj);
  const ts = obj.timestamp ?? obj.create_time ?? obj.created_at ?? data.update_time ?? data.timestamp;
  if (ts == null || String(ts).trim() === '') return null;
  return `${platform}:${code}:${productId}:${ts}`;
}

export async function ingestMarketplaceProductEvent(args: {
  tenantId: string;
  connection: MarketplaceConnection;
  platform: Platform;
  code: string;
  payload: unknown;
}): Promise<IngestProductEventResult> {
  const productId = extractProductId(args.platform, args.payload);
  if (!productId) return { status: 'no_product_id' };

  const eventKey = buildEventKey(args.platform, args.code, productId, args.payload);
  const existing = await getMappingByExternal(args.connection.id, productId);
  if (existing && isDuplicateEvent(existing.last_event_key, eventKey)) {
    return { status: 'duplicate', mappingId: existing.id };
  }

  let detail;
  try {
    detail = await fetchNormalizedProductDetail({ connection: args.connection, productId });
  } catch (err) {
    logErrorBrief(`[product-event] detail fetch failed (tenant=${args.tenantId}, product=${productId})`, err);
    return { status: 'error' };
  }
  if (!detail) return { status: 'detail_not_found' };

  const result = await ingestMarketplaceProduct({
    tenantId: args.tenantId,
    connection: args.connection,
    detail,
    trigger: 'webhook',
    eventKey,
  });
  await notifyProductSyncDecision(args.tenantId, result.notice);

  // Bidirectional sync: reconcile the per-SKU stock delta into internal truth and fan out to the
  // other mapped stores (notify or autopilot). Fire-and-forget — never block/break the ingest ack.
  if (result.mappingId) {
    void reconcileAndPropagateFromMarketplace({
      tenantId: args.tenantId,
      connection: args.connection,
      detail,
      mappingId: result.mappingId,
    }).catch((err) => logErrorBrief('[product-event] sync propagation failed', err));
  }

  return { status: 'ingested', mappingId: result.mappingId, decision: result.decision };
}
