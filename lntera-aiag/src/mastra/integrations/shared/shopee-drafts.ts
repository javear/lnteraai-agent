import { getSupabase } from './supabase';
import type { Uuid } from './types';

const TABLE = 'shopee_product_drafts';

export type ShopeeDraftStatus = 'open' | 'published' | 'discarded';

export interface ShopeeDraftRow {
  id: string;
  tenant_id: Uuid;
  marketplace_connection_id: string | null;
  external_shop_id: string;
  status: ShopeeDraftStatus;
  data: Record<string, unknown>;
  published_item_id: string | null;
  last_publish_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertShopeeDraftInput {
  tenantId: Uuid;
  externalShopId: string;
  marketplaceConnectionId?: string | null;
  data: Record<string, unknown>;
}

export async function insertShopeeDraft(input: InsertShopeeDraftInput): Promise<ShopeeDraftRow> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      tenant_id: input.tenantId,
      external_shop_id: input.externalShopId,
      marketplace_connection_id: input.marketplaceConnectionId ?? null,
      data: input.data,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to insert Shopee draft: ${error?.message ?? 'unknown error'}`);
  }
  return data as ShopeeDraftRow;
}

export async function getShopeeDraftById(
  id: string,
  tenantId: Uuid,
): Promise<ShopeeDraftRow | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read Shopee draft ${id}: ${error.message}`);
  }
  return (data as ShopeeDraftRow | null) ?? null;
}

export async function patchShopeeDraftData(
  id: string,
  tenantId: Uuid,
  data: Record<string, unknown>,
): Promise<ShopeeDraftRow> {
  const { data: row, error } = await getSupabase()
    .from(TABLE)
    .update({ data })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single();
  if (error || !row) {
    throw new Error(`Failed to update Shopee draft ${id}: ${error?.message ?? 'unknown error'}`);
  }
  return row as ShopeeDraftRow;
}

export async function markShopeeDraftPublished(
  id: string,
  tenantId: Uuid,
  publishedItemId: string,
): Promise<ShopeeDraftRow> {
  const { data: row, error } = await getSupabase()
    .from(TABLE)
    .update({ status: 'published', published_item_id: publishedItemId, last_publish_error: null })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single();
  if (error || !row) {
    throw new Error(`Failed to mark Shopee draft ${id} published: ${error?.message ?? 'unknown error'}`);
  }
  return row as ShopeeDraftRow;
}

export async function recordShopeeDraftPublishError(
  id: string,
  tenantId: Uuid,
  message: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from(TABLE)
    .update({ last_publish_error: message })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) {
    // Best-effort; don't throw because the original publish error is more important.
    console.warn(`Failed to record Shopee draft publish error: ${error.message}`);
  }
}

export async function markShopeeDraftDiscarded(
  id: string,
  tenantId: Uuid,
): Promise<ShopeeDraftRow> {
  const { data: row, error } = await getSupabase()
    .from(TABLE)
    .update({ status: 'discarded' })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single();
  if (error || !row) {
    throw new Error(`Failed to discard Shopee draft ${id}: ${error?.message ?? 'unknown error'}`);
  }
  return row as ShopeeDraftRow;
}

export async function listShopeeDrafts(
  tenantId: Uuid,
  options: { externalShopId?: string; status?: ShopeeDraftStatus; limit?: number } = {},
): Promise<ShopeeDraftRow[]> {
  let query = getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(options.limit ?? 50);
  if (options.externalShopId) {
    query = query.eq('external_shop_id', options.externalShopId);
  }
  if (options.status) {
    query = query.eq('status', options.status);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list Shopee drafts: ${error.message}`);
  }
  return (data as ShopeeDraftRow[] | null) ?? [];
}
