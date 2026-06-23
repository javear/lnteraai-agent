// product_sku_links: per-SKU cross-store join + delta snapshot + echo write-marker (migration 0019).
import { getSupabase } from '../shared/supabase';

export interface SkuLinkRow {
  id: string;
  tenant_id: string;
  mapping_id: string;
  internal_sku_id: string;
  external_sku_id: string | null;
  last_seen_external_stock: number | null;
  last_pushed_external_stock: number | null;
  last_pushed_price: number | null;
  last_push_at: string | null;
}

const TABLE = 'product_sku_links';

function toNum(v: number | string | null): number | null {
  return v == null ? null : Number(v);
}

export async function getLinksByMapping(mappingId: string): Promise<SkuLinkRow[]> {
  const { data, error } = await getSupabase().from(TABLE).select('*').eq('mapping_id', mappingId);
  if (error) throw new Error(`Failed to read sku links: ${error.message}`);
  return ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    mapping_id: r.mapping_id as string,
    internal_sku_id: r.internal_sku_id as string,
    external_sku_id: (r.external_sku_id as string | null) ?? null,
    last_seen_external_stock: toNum(r.last_seen_external_stock as number | string | null),
    last_pushed_external_stock: toNum(r.last_pushed_external_stock as number | string | null),
    last_pushed_price: toNum(r.last_pushed_price as number | string | null),
    last_push_at: (r.last_push_at as string | null) ?? null,
  }));
}

/** Seed/refresh a link (idempotent on (mapping_id, internal_sku_id)). */
export async function upsertSkuLink(input: {
  tenantId: string;
  mappingId: string;
  internalSkuId: string;
  externalSkuId?: string | null;
}): Promise<SkuLinkRow> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .upsert(
      {
        tenant_id: input.tenantId,
        mapping_id: input.mappingId,
        internal_sku_id: input.internalSkuId,
        external_sku_id: input.externalSkuId ?? null,
      },
      { onConflict: 'mapping_id,internal_sku_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(`Failed to upsert sku link: ${error.message}`);
  return (await getLinksByMapping((data as { mapping_id: string }).mapping_id)).find(
    (l) => l.internal_sku_id === input.internalSkuId,
  )!;
}

export async function updateLinkSnapshot(
  id: string,
  patch: {
    lastSeenExternalStock?: number | null;
    lastPushedExternalStock?: number | null;
    lastPushedPrice?: number | null;
    touchPushAt?: boolean;
  },
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.lastSeenExternalStock !== undefined) row.last_seen_external_stock = patch.lastSeenExternalStock;
  if (patch.lastPushedExternalStock !== undefined) row.last_pushed_external_stock = patch.lastPushedExternalStock;
  if (patch.lastPushedPrice !== undefined) row.last_pushed_price = patch.lastPushedPrice;
  if (patch.touchPushAt) row.last_push_at = new Date().toISOString();
  if (Object.keys(row).length === 0) return;
  const { error } = await getSupabase().from(TABLE).update(row).eq('id', id);
  if (error) throw new Error(`Failed to update sku link: ${error.message}`);
}
