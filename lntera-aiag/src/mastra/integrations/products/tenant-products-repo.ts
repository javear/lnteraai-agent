// Persists internal products + SKUs + per-warehouse inventory, embedding the short text via Qwen3.
// On UPDATE, SKUs are reconciled IN PLACE (matched by external_sku_id → seller_sku → position), NOT
// full-replaced: this keeps sku_id stable and preserves the delta-managed inventory quantity + the
// internal-canonical price, so the bidirectional-sync engine has a real internal ledger to work from.
// (A marketplace refresh updates descriptive fields + seeds NEW sku/warehouse rows, but never resets
// an existing inventory quantity or overwrites internal price.) Re-embedding is skipped when the
// source text + version are unchanged (guards the embedding spend).
import { getSupabase } from '../shared/supabase';
import {
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  embedText,
  toPgVectorLiteral,
} from '../embeddings/qwen-embeddings';
import { buildEmbeddingText } from '../embeddings/product-embedding-text';
import type { TenantProductWrite } from './product-mapper';

const PRODUCTS = 'tenant_products';
const SKUS = 'tenant_product_skus';
const WAREHOUSES = 'tenant_warehouses';
const INVENTORY = 'tenant_inventory';

export async function upsertTenantProductWithEmbedding(
  write: TenantProductWrite,
  opts: { existingProductId?: string | null } = {},
): Promise<{ productId: string; embedded: boolean }> {
  const supabase = getSupabase();
  const existingId = opts.existingProductId ?? null;

  // Decide whether to (re-)embed.
  let needEmbed = true;
  if (existingId) {
    const { data: cur } = await supabase
      .from(PRODUCTS)
      .select('embedding_source_text, embedding_version, embedding')
      .eq('id', existingId)
      .maybeSingle();
    const row = cur as { embedding_source_text: string | null; embedding_version: number | null; embedding: unknown } | null;
    if (
      row &&
      row.embedding != null &&
      row.embedding_version === EMBEDDING_VERSION &&
      row.embedding_source_text === write.embeddingSourceText
    ) {
      needEmbed = false;
    }
  }

  const baseRow: Record<string, unknown> = {
    tenant_id: write.tenantId,
    source_origin: write.sourceOrigin,
    source_platform: write.sourcePlatform,
    source_connection_id: write.sourceConnectionId,
    title: write.title,
    brand: write.brand,
    uom: write.uom,
    status: write.status,
    currency: write.currency,
    description: write.description,
    category_id: write.categoryId,
    brand_id: write.brandId,
    image_urls: write.imageUrls,
    attributes: write.attributes,
    dimensions: write.dimensions,
    weight_grams: write.weightGrams,
    raw: write.raw,
    embedding_source_text: write.embeddingSourceText,
  };

  if (needEmbed) {
    const vector = await embedText(write.embeddingSourceText || write.title);
    baseRow.embedding = toPgVectorLiteral(vector);
    baseRow.embedding_model = EMBEDDING_MODEL;
    baseRow.embedding_version = EMBEDDING_VERSION;
    baseRow.embedded_at = new Date().toISOString();
  }

  let productId: string;
  if (existingId) {
    const { data, error } = await supabase
      .from(PRODUCTS)
      .update(baseRow)
      .eq('id', existingId)
      .eq('tenant_id', write.tenantId)
      .select('id')
      .single();
    if (error) throw new Error(`Failed to update tenant product: ${error.message}`);
    productId = (data as { id: string }).id;
    // Reconcile SKUs IN PLACE (no full-replace): preserves sku_id, the delta-managed inventory
    // quantity, and the internal-canonical price — the stable ledger the sync engine relies on.
    await reconcileSkusAndInventory(write, productId);
  } else {
    const { data, error } = await supabase.from(PRODUCTS).insert(baseRow).select('id').single();
    if (error) throw new Error(`Failed to insert tenant product: ${error.message}`);
    productId = (data as { id: string }).id;
    await writeSkusAndInventory(write, productId);
  }

  return { productId, embedded: needEmbed };
}

async function writeSkusAndInventory(write: TenantProductWrite, productId: string): Promise<void> {
  const supabase = getSupabase();
  if (write.skus.length === 0) return;

  const skuRows = write.skus.map((s) => ({
    tenant_id: write.tenantId,
    product_id: productId,
    seller_sku: s.sellerSku,
    label: s.label,
    attributes: s.attributes,
    price: s.price,
    currency: s.currency,
    image_url: s.imageUrl,
    external_sku_id: s.externalSkuId,
    position: s.position,
  }));
  const { data: insertedSkus, error: skuErr } = await supabase
    .from(SKUS)
    .insert(skuRows)
    .select('id, position');
  if (skuErr) throw new Error(`Failed to insert SKUs: ${skuErr.message}`);
  const skuIdByPosition = new Map<number, string>();
  for (const row of (insertedSkus as Array<{ id: string; position: number }> | null) ?? []) {
    skuIdByPosition.set(row.position, row.id);
  }

  const platform = write.sourcePlatform ?? null;
  const warehouseCache = new Map<string, string>();
  const inventoryRows: Array<Record<string, unknown>> = [];
  for (const sku of write.skus) {
    const skuId = skuIdByPosition.get(sku.position);
    if (!skuId) continue;
    for (const inv of sku.inventory) {
      const warehouseId = await getOrCreateWarehouseId(
        write.tenantId,
        platform,
        inv.externalWarehouseId,
        warehouseCache,
      );
      inventoryRows.push({
        tenant_id: write.tenantId,
        sku_id: skuId,
        warehouse_id: warehouseId,
        quantity: inv.quantity,
      });
    }
  }
  if (inventoryRows.length > 0) {
    const { error: invErr } = await supabase
      .from(INVENTORY)
      .upsert(inventoryRows, { onConflict: 'sku_id,warehouse_id' });
    if (invErr) throw new Error(`Failed to write inventory: ${invErr.message}`);
  }
}

/**
 * Non-destructive SKU/inventory sync for an EXISTING product (the bidirectional-sync ledger path).
 * Matches each incoming SKU to an existing row by external_sku_id → seller_sku → position and UPDATES
 * its descriptive fields (NOT price/currency — internal-canonical), inserts genuinely-new SKUs, and
 * seeds inventory only for (sku, warehouse) rows that don't exist yet (`ignoreDuplicates`) so an
 * existing, delta-managed quantity is never reset. Removed-on-marketplace SKUs are left in place
 * (preserving inventory + product_sku_links).
 */
async function reconcileSkusAndInventory(write: TenantProductWrite, productId: string): Promise<void> {
  const supabase = getSupabase();
  if (write.skus.length === 0) return;

  const { data: existingRows, error: exErr } = await supabase
    .from(SKUS)
    .select('id, external_sku_id, seller_sku, position')
    .eq('product_id', productId);
  if (exErr) throw new Error(`Failed to read existing SKUs: ${exErr.message}`);
  const existing =
    (existingRows as Array<{ id: string; external_sku_id: string | null; seller_sku: string | null; position: number | null }> | null) ?? [];

  const byExternal = new Map<string, string>();
  const bySeller = new Map<string, string>();
  const byPosition = new Map<number, string>();
  for (const r of existing) {
    if (r.external_sku_id) byExternal.set(r.external_sku_id, r.id);
    if (r.seller_sku) bySeller.set(r.seller_sku, r.id);
    if (r.position != null) byPosition.set(r.position, r.id);
  }

  const claimed = new Set<string>();
  const skuIdByIndex = new Map<number, string>();
  const newPayloads: Array<{ idx: number; row: Record<string, unknown> }> = [];

  for (let i = 0; i < write.skus.length; i++) {
    const s = write.skus[i];
    const extId = s.externalSkuId && byExternal.get(s.externalSkuId);
    const selId = s.sellerSku && bySeller.get(s.sellerSku);
    const posId = s.position != null ? byPosition.get(s.position) : undefined;
    const matchId =
      (extId && !claimed.has(extId) && extId) ||
      (selId && !claimed.has(selId) && selId) ||
      (posId && !claimed.has(posId) && posId) ||
      undefined;

    if (matchId) {
      claimed.add(matchId);
      skuIdByIndex.set(i, matchId);
      // Descriptive fields only — price/currency stay internal-canonical.
      const { error } = await supabase
        .from(SKUS)
        .update({
          seller_sku: s.sellerSku,
          label: s.label,
          attributes: s.attributes,
          image_url: s.imageUrl,
          external_sku_id: s.externalSkuId,
          position: s.position,
        })
        .eq('id', matchId);
      if (error) throw new Error(`Failed to update SKU: ${error.message}`);
    } else {
      newPayloads.push({
        idx: i,
        row: {
          tenant_id: write.tenantId,
          product_id: productId,
          seller_sku: s.sellerSku,
          label: s.label,
          attributes: s.attributes,
          price: s.price,
          currency: s.currency,
          image_url: s.imageUrl,
          external_sku_id: s.externalSkuId,
          position: s.position,
        },
      });
    }
  }

  if (newPayloads.length > 0) {
    const { data: inserted, error } = await supabase
      .from(SKUS)
      .insert(newPayloads.map((p) => p.row))
      .select('id, position, external_sku_id, seller_sku');
    if (error) throw new Error(`Failed to insert new SKUs: ${error.message}`);
    const rows =
      (inserted as Array<{ id: string; position: number | null; external_sku_id: string | null; seller_sku: string | null }> | null) ?? [];
    for (const p of newPayloads) {
      const s = write.skus[p.idx];
      const row = rows.find(
        (r) =>
          (s.externalSkuId && r.external_sku_id === s.externalSkuId) ||
          (s.sellerSku && r.seller_sku === s.sellerSku) ||
          r.position === s.position,
      );
      if (row) skuIdByIndex.set(p.idx, row.id);
    }
  }

  const platform = write.sourcePlatform ?? null;
  const warehouseCache = new Map<string, string>();
  const inventoryRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < write.skus.length; i++) {
    const skuId = skuIdByIndex.get(i);
    if (!skuId) continue;
    for (const inv of write.skus[i].inventory) {
      const warehouseId = await getOrCreateWarehouseId(write.tenantId, platform, inv.externalWarehouseId, warehouseCache);
      inventoryRows.push({ tenant_id: write.tenantId, sku_id: skuId, warehouse_id: warehouseId, quantity: inv.quantity });
    }
  }
  if (inventoryRows.length > 0) {
    // ignoreDuplicates: seed NEW (sku,warehouse) rows only; never reset an existing (delta-managed) qty.
    const { error: invErr } = await supabase
      .from(INVENTORY)
      .upsert(inventoryRows, { onConflict: 'sku_id,warehouse_id', ignoreDuplicates: true });
    if (invErr) throw new Error(`Failed to seed inventory: ${invErr.message}`);
  }
}

async function getOrCreateWarehouseId(
  tenantId: string,
  platform: string | null,
  externalWarehouseId: string | null,
  cache: Map<string, string>,
): Promise<string> {
  const supabase = getSupabase();
  const cacheKey = `${platform ?? ''}::${externalWarehouseId ?? '__default__'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (externalWarehouseId) {
    const { data, error } = await supabase
      .from(WAREHOUSES)
      .upsert(
        { tenant_id: tenantId, platform, external_warehouse_id: externalWarehouseId },
        { onConflict: 'tenant_id,platform,external_warehouse_id' },
      )
      .select('id')
      .single();
    if (error) throw new Error(`Failed to upsert warehouse: ${error.message}`);
    const id = (data as { id: string }).id;
    cache.set(cacheKey, id);
    return id;
  }

  // Default warehouse (platforms that only expose a stock summary, e.g. Shopee).
  let lookup = supabase.from(WAREHOUSES).select('id').eq('tenant_id', tenantId).eq('is_default', true);
  lookup = platform ? lookup.eq('platform', platform) : lookup.is('platform', null);
  const { data: existing } = await lookup.limit(1).maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    cache.set(cacheKey, id);
    return id;
  }
  const { data: created, error } = await supabase
    .from(WAREHOUSES)
    .insert({ tenant_id: tenantId, platform, external_warehouse_id: null, is_default: true, name: 'Default' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create default warehouse: ${error.message}`);
  const id = (created as { id: string }).id;
  cache.set(cacheKey, id);
  return id;
}

/** Delete an internal product (SKUs + inventory cascade). Tenant-scoped. Used by Undo. */
export async function deleteTenantProduct(tenantId: string, productId: string): Promise<void> {
  const { error } = await getSupabase()
    .from(PRODUCTS)
    .delete()
    .eq('id', productId)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to delete tenant product: ${error.message}`);
}

/** Recompute + persist the embedding for an internal product (used on re-score / version bump). */
export async function reembedTenantProduct(productId: string): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(PRODUCTS)
    .select('embedding_source_text, title')
    .eq('id', productId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read product for re-embed: ${error.message}`);
  const row = data as { embedding_source_text: string | null; title: string | null } | null;
  if (!row) return;
  const text = row.embedding_source_text || row.title || '';
  if (!text) return;
  const vector = await embedText(text);
  const { error: updErr } = await supabase
    .from(PRODUCTS)
    .update({
      embedding: toPgVectorLiteral(vector),
      embedding_model: EMBEDDING_MODEL,
      embedding_version: EMBEDDING_VERSION,
      embedded_at: new Date().toISOString(),
    })
    .eq('id', productId);
  if (updErr) throw new Error(`Failed to persist re-embed: ${updErr.message}`);
}

// Re-export so callers can compose query text without reaching into embeddings/.
export { buildEmbeddingText };
