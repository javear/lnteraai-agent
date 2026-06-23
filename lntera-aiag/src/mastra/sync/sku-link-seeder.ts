// Ensures product_sku_links exist for a mapping (internal SKU ↔ that store's external SKU). Seeds from
// the store's current detail via the SKU matcher, recording each store's current stock as the delta
// baseline (last_seen_external_stock) so the first subsequent webhook computes a 0 delta, not a phantom sale.
import type { MarketplaceConnection } from '../integrations/shared/types';
import type { NormalizedProductDetail } from '../integrations/shared/products';
import { fetchNormalizedProductDetail } from '../integrations/shared/product-detail-fetch';
import { getLinksByMapping, upsertSkuLink, updateLinkSnapshot, type SkuLinkRow } from '../integrations/products/sku-links-repo';
import type { InternalSkuStock } from '../integrations/products/inventory-repo';
import { matchSkus } from './sku-matcher';

export async function ensureSkuLinks(args: {
  tenantId: string;
  mappingId: string;
  connection: MarketplaceConnection;
  externalProductId: string;
  internalSkus: InternalSkuStock[];
  /** Pre-fetched detail (the feeder already has it); fetched on demand otherwise. */
  detail?: NormalizedProductDetail | null;
}): Promise<SkuLinkRow[]> {
  const existing = await getLinksByMapping(args.mappingId);
  if (existing.length > 0) return existing;
  if (args.internalSkus.length === 0) return existing;

  const detail =
    args.detail ??
    (await fetchNormalizedProductDetail({ connection: args.connection, productId: args.externalProductId }).catch(() => null));
  if (!detail || detail.variants.length === 0) return existing;

  const matches = matchSkus(
    args.internalSkus.map((s, i) => ({
      sellerSku: s.sellerSku,
      externalSkuId: s.externalSkuId,
      attributes: s.attributes,
      position: s.position ?? i,
    })),
    detail.variants.map((v, i) => ({
      sellerSku: v.sellerSku ?? null,
      externalSkuId: v.skuId,
      attributes: v.attributes ?? null,
      position: i,
    })),
  );

  for (const m of matches) {
    const internalSku = args.internalSkus[m.internalIndex];
    const variant = detail.variants[m.externalIndex];
    const link = await upsertSkuLink({
      tenantId: args.tenantId,
      mappingId: args.mappingId,
      internalSkuId: internalSku.id,
      externalSkuId: variant.skuId,
    });
    // Baseline the delta snapshot at the store's current stock.
    if (typeof variant.stock === 'number') {
      await updateLinkSnapshot(link.id, { lastSeenExternalStock: variant.stock });
    }
  }

  return getLinksByMapping(args.mappingId);
}
