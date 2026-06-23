// Internal inventory + SKU access for the bidirectional-sync engine. Internal is the source of truth;
// stock mutates through the atomic apply_inventory_delta RPC so concurrent sales compose safely.
import { getSupabase } from '../shared/supabase';

export interface InternalSkuStock {
  id: string; // internal sku id
  sellerSku: string | null;
  externalSkuId: string | null;
  attributes: Array<{ name?: string | null; value?: string | null }> | null;
  position: number | null;
  price: number | null;
  currency: string | null;
  /** Total available across all warehouses. */
  quantity: number;
  /** Warehouse to apply deltas against (the row holding the most stock; MVP collapses multi-warehouse). */
  primaryWarehouseId: string | null;
}

export async function getProductSkusWithStock(tenantId: string, productId: string): Promise<InternalSkuStock[]> {
  const supabase = getSupabase();
  const { data: skus, error } = await supabase
    .from('tenant_product_skus')
    .select('id, seller_sku, external_sku_id, attributes, position, price, currency')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId);
  if (error) throw new Error(`Failed to read product SKUs: ${error.message}`);
  const skuRows =
    (skus as Array<{
      id: string;
      seller_sku: string | null;
      external_sku_id: string | null;
      attributes: Array<{ name?: string | null; value?: string | null }> | null;
      position: number | null;
      price: number | string | null;
      currency: string | null;
    }> | null) ?? [];
  if (skuRows.length === 0) return [];

  const ids = skuRows.map((s) => s.id);
  const { data: inv, error: invErr } = await supabase
    .from('tenant_inventory')
    .select('sku_id, warehouse_id, quantity')
    .in('sku_id', ids);
  if (invErr) throw new Error(`Failed to read inventory: ${invErr.message}`);

  const bySku = new Map<string, Array<{ warehouseId: string | null; quantity: number }>>();
  for (const r of (inv as Array<{ sku_id: string; warehouse_id: string | null; quantity: number | string }> | null) ?? []) {
    const list = bySku.get(r.sku_id) ?? [];
    list.push({ warehouseId: r.warehouse_id, quantity: Number(r.quantity) || 0 });
    bySku.set(r.sku_id, list);
  }

  return skuRows.map((s) => {
    const list = bySku.get(s.id) ?? [];
    const quantity = list.reduce((a, b) => a + b.quantity, 0);
    const primary = list.slice().sort((a, b) => b.quantity - a.quantity)[0]?.warehouseId ?? null;
    return {
      id: s.id,
      sellerSku: s.seller_sku,
      externalSkuId: s.external_sku_id,
      attributes: s.attributes,
      position: s.position,
      price: s.price == null ? null : Number(s.price),
      currency: s.currency,
      quantity,
      primaryWarehouseId: primary,
    };
  });
}

/** Atomic, never-negative delta (RPC). Returns the new quantity, or null if no inventory row exists. */
export async function applyInventoryDelta(skuId: string, warehouseId: string | null, delta: number): Promise<number | null> {
  const { data, error } = await getSupabase().rpc('apply_inventory_delta', {
    p_sku_id: skuId,
    p_warehouse_id: warehouseId,
    p_delta: delta,
  });
  if (error) throw new Error(`Failed to apply inventory delta: ${error.message}`);
  return data == null ? null : Number(data);
}

export async function setSkuPrice(skuId: string, price: number, currency?: string | null): Promise<void> {
  const fields: Record<string, unknown> = { price };
  if (currency !== undefined) fields.currency = currency;
  const { error } = await getSupabase().from('tenant_product_skus').update(fields).eq('id', skuId);
  if (error) throw new Error(`Failed to set SKU price: ${error.message}`);
}
