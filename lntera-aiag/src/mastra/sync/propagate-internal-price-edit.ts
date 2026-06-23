// Internal price-edit trigger. When the agent sets a product's price on one store (update-product-price),
// treat that value as the internal base (price is internal→stores only — no margin reversal), then fan it
// out to the OTHER mapped stores with each store's margin. Stock doesn't need this: a stock edit produces
// a marketplace webhook that the feeder already turns into a propagation.
import { logErrorBrief } from '../logger/compact-error';
import { listConnectionsByTenant } from '../integrations/shared/supabase';
import type { Platform } from '../integrations/shared/types';
import { getMappingByExternal, isDecidedStatus } from '../integrations/products/product-mappings-repo';
import { getProductSkusWithStock, setSkuPrice } from '../integrations/products/inventory-repo';
import { ensureSkuLinks } from './sku-link-seeder';
import { propagateAttributeChange } from './propagate-attribute-change';

export async function propagateInternalPriceEdit(args: {
  tenantId: string;
  platform: Platform;
  externalProductId: string;
  perSku: Array<{ externalSkuId: string; price: number }>;
}): Promise<void> {
  try {
    const conns = await listConnectionsByTenant(args.tenantId, [args.platform]);
    let mapping = null;
    let connection = null;
    for (const c of conns) {
      const m = await getMappingByExternal(c.id, args.externalProductId);
      if (m && m.internal_product_id && isDecidedStatus(m.status)) {
        mapping = m;
        connection = c;
        break;
      }
    }
    if (!mapping || !connection || !mapping.internal_product_id) return;
    const masterProductId = mapping.internal_product_id;

    const internalSkus = await getProductSkusWithStock(args.tenantId, masterProductId);
    if (internalSkus.length === 0) return;

    const links = await ensureSkuLinks({
      tenantId: args.tenantId,
      mappingId: mapping.id,
      connection,
      externalProductId: args.externalProductId,
      internalSkus,
    });
    const internalByExternal = new Map(links.filter((l) => l.external_sku_id).map((l) => [l.external_sku_id as string, l.internal_sku_id]));

    let changed = false;
    for (const u of args.perSku) {
      let internalSkuId = internalByExternal.get(u.externalSkuId);
      // Single-SKU fallback (e.g. Shopee model_id 0 not matching the link's seeded id).
      if (!internalSkuId && args.perSku.length === 1 && internalSkus.length === 1) internalSkuId = internalSkus[0].id;
      if (!internalSkuId || !Number.isFinite(u.price)) continue;
      await setSkuPrice(internalSkuId, u.price);
      changed = true;
    }
    if (!changed) return;

    await propagateAttributeChange({
      tenantId: args.tenantId,
      masterProductId,
      attribute: 'price',
      sourceConnectionId: connection.id, // the store the agent edited keeps its exact price
      sourceSummary: 'Price updated.',
    });
  } catch (err) {
    logErrorBrief('[sync] internal price-edit propagation failed', err);
  }
}
