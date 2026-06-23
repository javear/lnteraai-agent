// CRUD for product_mappings (internal product ↔ marketplace listing link). The unique key
// (marketplace_connection_id, external_product_id) makes ingest idempotent. Decided links
// ('confirmed' | 'rejected' | 'ignored' | 'auto_mapped' | 'new_created') are never silently
// re-routed — ingest only refreshes their score/name. Shared with applyProductSyncAction.
import { getSupabase } from '../shared/supabase';

export type ProductMappingStatus =
  | 'suggested'
  | 'confirmed'
  | 'rejected'
  | 'auto_mapped'
  | 'new_created'
  | 'unmatched'
  | 'ignored';

export type ProductMappingMatchedBy = 'system' | 'user' | 'auto_create' | 'auto_map';

/** Statuses where the user (or an opted-in auto rule) has settled the link — do not re-prompt. */
export const DECIDED_STATUSES: ProductMappingStatus[] = [
  'confirmed',
  'rejected',
  'ignored',
  'auto_mapped',
  'new_created',
];

export function isDecidedStatus(status: ProductMappingStatus): boolean {
  return DECIDED_STATUSES.includes(status);
}

export interface ProductMappingRow {
  id: string;
  tenant_id: string;
  internal_product_id: string | null;
  marketplace_connection_id: string;
  platform: string;
  external_product_id: string;
  external_product_name: string | null;
  match_score: number | null;
  status: ProductMappingStatus;
  matched_by: ProductMappingMatchedBy | null;
  raw: Record<string, unknown> | null;
  last_event_key: string | null;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
}

const TABLE = 'product_mappings';

export async function getMappingByExternal(
  connectionId: string,
  externalProductId: string,
): Promise<ProductMappingRow | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('marketplace_connection_id', connectionId)
    .eq('external_product_id', externalProductId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read mapping: ${error.message}`);
  return (data as ProductMappingRow | null) ?? null;
}

export async function getMappingById(id: string): Promise<ProductMappingRow | null> {
  const { data, error } = await getSupabase().from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Failed to read mapping by id: ${error.message}`);
  return (data as ProductMappingRow | null) ?? null;
}

/** All DECIDED mappings (across every store) that point at one internal product — the fan-out targets
 *  for bidirectional propagation. (Uses the product_mappings_internal_idx index.) */
export async function getDecidedMappingsByInternal(internalProductId: string): Promise<ProductMappingRow[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('internal_product_id', internalProductId)
    .in('status', DECIDED_STATUSES);
  if (error) throw new Error(`Failed to read mappings by internal product: ${error.message}`);
  return (data as ProductMappingRow[] | null) ?? [];
}

export interface UpsertMappingInput {
  tenantId: string;
  internalProductId?: string | null;
  connectionId: string;
  platform: string;
  externalProductId: string;
  externalProductName?: string | null;
  matchScore?: number | null;
  status: ProductMappingStatus;
  matchedBy?: ProductMappingMatchedBy | null;
  raw?: Record<string, unknown> | null;
  lastEventKey?: string | null;
}

function toRow(input: UpsertMappingInput): Record<string, unknown> {
  return {
    tenant_id: input.tenantId,
    internal_product_id: input.internalProductId ?? null,
    marketplace_connection_id: input.connectionId,
    platform: input.platform,
    external_product_id: input.externalProductId,
    external_product_name: input.externalProductName ?? null,
    match_score: input.matchScore ?? null,
    status: input.status,
    matched_by: input.matchedBy ?? null,
    raw: input.raw ?? null,
    last_event_key: input.lastEventKey ?? null,
    last_matched_at: new Date().toISOString(),
  };
}

/** Idempotent insert-or-replace on (marketplace_connection_id, external_product_id). */
export async function upsertMapping(input: UpsertMappingInput): Promise<ProductMappingRow> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .upsert(toRow(input), { onConflict: 'marketplace_connection_id,external_product_id' })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to upsert mapping: ${error.message}`);
  return data as ProductMappingRow;
}

export interface UpdateMappingPatch {
  internalProductId?: string | null;
  externalProductName?: string | null;
  matchScore?: number | null;
  status?: ProductMappingStatus;
  matchedBy?: ProductMappingMatchedBy | null;
  raw?: Record<string, unknown> | null;
  lastEventKey?: string | null;
  touchMatchedAt?: boolean;
}

export async function updateMapping(id: string, patch: UpdateMappingPatch): Promise<ProductMappingRow | null> {
  const row: Record<string, unknown> = {};
  if (patch.internalProductId !== undefined) row.internal_product_id = patch.internalProductId;
  if (patch.externalProductName !== undefined) row.external_product_name = patch.externalProductName;
  if (patch.matchScore !== undefined) row.match_score = patch.matchScore;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.matchedBy !== undefined) row.matched_by = patch.matchedBy;
  if (patch.raw !== undefined) row.raw = patch.raw;
  if (patch.lastEventKey !== undefined) row.last_event_key = patch.lastEventKey;
  if (patch.touchMatchedAt) row.last_matched_at = new Date().toISOString();
  if (Object.keys(row).length === 0) return getMappingById(id);

  const { data, error } = await getSupabase().from(TABLE).update(row).eq('id', id).select('*').maybeSingle();
  if (error) throw new Error(`Failed to update mapping: ${error.message}`);
  return (data as ProductMappingRow | null) ?? null;
}
