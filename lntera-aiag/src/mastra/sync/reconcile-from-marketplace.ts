// Marketplace feeder: after the ingest path refreshes a DECIDED product from a webhook, compute the
// per-SKU stock DELTA vs our last-seen baseline and hand it to the sync engine, which gates BOTH the
// internal-master update AND the fan-out to the other stores under one notify/autopilot permission —
// nothing is written silently. The echo write-marker skips values we ourselves just pushed (no bounce
// loop). PRICE is intentionally NOT pulled back from marketplaces (internal → stores only).
import type { MarketplaceConnection } from '../integrations/shared/types';
import type { NormalizedProductDetail } from '../integrations/shared/products';
import { logErrorBrief } from '../logger/compact-error';
import { getMappingById, isDecidedStatus } from '../integrations/products/product-mappings-repo';
import { getProductSkusWithStock, applyInventoryDelta } from '../integrations/products/inventory-repo';
import { updateLinkSnapshot } from '../integrations/products/sku-links-repo';
import { ensureSkuLinks } from './sku-link-seeder';
import { propagateAttributeChange, type InternalStockDelta } from './propagate-attribute-change';

const ECHO_WINDOW_MS = 90_000;

export async function reconcileAndPropagateFromMarketplace(args: {
  tenantId: string;
  connection: MarketplaceConnection;
  detail: NormalizedProductDetail;
  mappingId: string;
}): Promise<void> {
  try {
    const mapping = await getMappingById(args.mappingId);
    if (!mapping || !mapping.internal_product_id || !isDecidedStatus(mapping.status)) return;
    const masterProductId = mapping.internal_product_id;

    const internalSkus = await getProductSkusWithStock(args.tenantId, masterProductId);
    if (internalSkus.length === 0) return;
    const internalById = new Map(internalSkus.map((s) => [s.id, s]));

    const links = await ensureSkuLinks({
      tenantId: args.tenantId,
      mappingId: mapping.id,
      connection: args.connection,
      externalProductId: mapping.external_product_id,
      internalSkus,
      detail: args.detail,
      // This is the source marketplace → align internal to its current stock on first seed.
      adoptInternalStock: true,
    });
    if (links.length === 0) return;

    const extStockBySku = new Map<string, number>();
    for (const v of args.detail.variants) {
      if (typeof v.stock === 'number') extStockBySku.set(v.skuId, v.stock);
    }

    const now = Date.now();
    const internalDeltas: InternalStockDelta[] = [];
    const diag: string[] = []; // per-SKU verdict (fetched vs last-seen) so "no change" is self-explanatory
    for (const link of links) {
      if (!link.external_sku_id) {
        diag.push('sku?:no-external-id');
        continue;
      }
      const sku = link.external_sku_id;
      const fresh = extStockBySku.get(sku);
      if (typeof fresh !== 'number') {
        diag.push(`${sku}:no-stock-in-detail`);
        continue;
      }

      // Echo guard: a value we just pushed bouncing back as a webhook → not a real change.
      if (
        link.last_pushed_external_stock != null &&
        link.last_push_at &&
        fresh === link.last_pushed_external_stock &&
        now - new Date(link.last_push_at).getTime() < ECHO_WINDOW_MS
      ) {
        await updateLinkSnapshot(link.id, { lastSeenExternalStock: fresh });
        diag.push(`${sku}:echo(${fresh})`);
        continue;
      }

      const internal = internalById.get(link.internal_sku_id);
      if (!internal) {
        diag.push(`${sku}:no-internal-sku`);
        continue;
      }
      const baseline = link.last_seen_external_stock;
      await updateLinkSnapshot(link.id, { lastSeenExternalStock: fresh });

      if (baseline == null) {
        // First sight of this link → adopt the marketplace's current stock as the internal baseline so
        // future deltas are computed correctly. This is initial DISCOVERY, not a change the seller made,
        // so it's applied directly (silent) and is NOT routed through the notify/autopilot gate.
        const adopt = fresh - internal.quantity;
        if (adopt !== 0) await applyInventoryDelta(internal.id, internal.primaryWarehouseId, adopt);
        diag.push(`${sku}:baseline-adopt(→${fresh})`);
        continue;
      }

      const delta = fresh - baseline;
      if (delta === 0) {
        diag.push(`${sku}:unchanged(${fresh})`);
        continue;
      }
      // A real change: do NOT touch internal here. Hand the delta to the engine so the internal-master
      // update is gated by the same notify/autopilot permission as the cross-store fan-out.
      internalDeltas.push({ internalSkuId: internal.id, delta });
      diag.push(`${sku}:delta(${baseline}→${fresh})`);
    }

    if (internalDeltas.length === 0) {
      // No net change → log what we fetched vs the baseline so it's obvious WHY (re-sent webhook, echo, etc.).
      console.info(`[sync] reconcile "${args.detail.title}": no stock change to sync — ${diag.join(', ')}`);
      return;
    }

    const platformLabel = args.connection.platform === 'tiktok' ? 'TikTok' : 'Shopee';
    await propagateAttributeChange({
      tenantId: args.tenantId,
      masterProductId,
      attribute: 'stock',
      sourceConnectionId: args.connection.id,
      sourceSummary: `${platformLabel} stock for "${args.detail.title}" changed.`,
      internalDeltas,
    });
  } catch (err) {
    logErrorBrief(`[sync] reconcile-from-marketplace failed (mapping=${args.mappingId})`, err);
  }
}
