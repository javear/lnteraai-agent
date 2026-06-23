// Marketplace feeder: after the ingest path refreshes a DECIDED product from a webhook, compute the
// per-SKU stock DELTA vs our last-seen baseline, apply it to internal truth (atomic RPC), and fan out
// to the OTHER stores. The echo write-marker skips values we ourselves just pushed (no bounce loop).
// PRICE is intentionally NOT pulled back from marketplaces (internal → stores only).
import type { MarketplaceConnection } from '../integrations/shared/types';
import type { NormalizedProductDetail } from '../integrations/shared/products';
import { logErrorBrief } from '../logger/compact-error';
import { getMappingById, isDecidedStatus } from '../integrations/products/product-mappings-repo';
import { getProductSkusWithStock, applyInventoryDelta } from '../integrations/products/inventory-repo';
import { updateLinkSnapshot } from '../integrations/products/sku-links-repo';
import { ensureSkuLinks } from './sku-link-seeder';
import { propagateAttributeChange } from './propagate-attribute-change';

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
    });
    if (links.length === 0) return;

    const extStockBySku = new Map<string, number>();
    for (const v of args.detail.variants) {
      if (typeof v.stock === 'number') extStockBySku.set(v.skuId, v.stock);
    }

    const now = Date.now();
    let appliedAnyDelta = false;
    for (const link of links) {
      if (!link.external_sku_id) continue;
      const fresh = extStockBySku.get(link.external_sku_id);
      if (typeof fresh !== 'number') continue;

      // Echo guard: a value we just pushed bouncing back as a webhook → not a real change.
      if (
        link.last_pushed_external_stock != null &&
        link.last_push_at &&
        fresh === link.last_pushed_external_stock &&
        now - new Date(link.last_push_at).getTime() < ECHO_WINDOW_MS
      ) {
        await updateLinkSnapshot(link.id, { lastSeenExternalStock: fresh });
        continue;
      }

      const internal = internalById.get(link.internal_sku_id);
      if (!internal) continue;
      const baseline = link.last_seen_external_stock;
      await updateLinkSnapshot(link.id, { lastSeenExternalStock: fresh });

      if (baseline == null) {
        // First sight of this link → adopt the marketplace's current stock as internal truth so the
        // internal master tracks reality immediately. No fan-out: an initial sync isn't a "change".
        const adopt = fresh - internal.quantity;
        if (adopt !== 0) await applyInventoryDelta(internal.id, internal.primaryWarehouseId, adopt);
        continue;
      }

      const delta = fresh - baseline;
      if (delta === 0) continue;
      await applyInventoryDelta(internal.id, internal.primaryWarehouseId, delta);
      appliedAnyDelta = true;
    }

    if (appliedAnyDelta) {
      const platformLabel = args.connection.platform === 'tiktok' ? 'TikTok' : 'Shopee';
      await propagateAttributeChange({
        tenantId: args.tenantId,
        masterProductId,
        attribute: 'stock',
        sourceConnectionId: args.connection.id,
        sourceSummary: `${platformLabel} stock for "${args.detail.title}" changed.`,
      });
    } else {
      console.info(`[sync] reconcile "${args.detail.title}": internal stock synced; no delta to propagate.`);
    }
  } catch (err) {
    logErrorBrief(`[sync] reconcile-from-marketplace failed (mapping=${args.mappingId})`, err);
  }
}
