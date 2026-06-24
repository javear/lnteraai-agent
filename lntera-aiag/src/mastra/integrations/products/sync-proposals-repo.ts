// sync_proposals: a computed propagation awaiting the user's Yes/Always/Dismiss (NOTIFY mode).
// migration 0020. The payload holds fully-computed per-store/per-SKU targets, but the apply handler
// re-validates against current internal truth before pushing — the snapshot is a convenience, not gospel.
import { getSupabase } from '../shared/supabase';

export type SyncAttribute = 'stock' | 'price';
export type SyncProposalStatus = 'pending' | 'applied' | 'dismissed' | 'expired';

export interface SyncProposalTargetSku {
  internalSkuId: string;
  externalSkuId: string | null;
  value: number; // target stock qty or price for this store+sku
}

export interface SyncProposalTarget {
  connectionId: string;
  platform: 'shopee' | 'tiktok';
  shopName: string | null;
  externalProductId: string;
  shopCipher?: string | null;
  skus: SyncProposalTargetSku[];
}

/** Proposed internal-master stock change, applied on approve (never silently). Stock only. */
export interface SyncProposalInternalDelta {
  internalSkuId: string;
  delta: number;
}

export interface SyncProposalPayload {
  productTitle: string;
  sourceSummary: string;
  targets: SyncProposalTarget[];
  /** Internal-master deltas to apply on approve (marketplace → internal). Absent/[] for price edits. */
  internalDeltas?: SyncProposalInternalDelta[];
}

export interface SyncProposalRow {
  id: string;
  tenant_id: string;
  master_product_id: string;
  attribute: SyncAttribute;
  source_connection_id: string | null;
  payload: SyncProposalPayload;
  status: SyncProposalStatus;
  created_at: string;
  expires_at: string | null;
  applied_at: string | null;
}

const TABLE = 'sync_proposals';
const TTL_MS = 24 * 60 * 60 * 1000;

export async function createProposal(input: {
  tenantId: string;
  masterProductId: string;
  attribute: SyncAttribute;
  sourceConnectionId: string | null;
  payload: SyncProposalPayload;
}): Promise<SyncProposalRow> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      tenant_id: input.tenantId,
      master_product_id: input.masterProductId,
      attribute: input.attribute,
      source_connection_id: input.sourceConnectionId,
      payload: input.payload,
      status: 'pending',
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to create sync proposal: ${error.message}`);
  return data as SyncProposalRow;
}

export async function getProposalById(id: string, tenantId: string): Promise<SyncProposalRow | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read sync proposal: ${error.message}`);
  return (data as SyncProposalRow | null) ?? null;
}

/**
 * Collapse still-pending proposals for the same product+attribute into the next one: sum their internal
 * deltas, mark them `expired`, and return the carried-forward total. Without this, ignoring a NOTIFY
 * proposal and changing the stock again would leave TWO pending notifications with stale, non-cumulative
 * deltas — applying both would double-count. The new proposal carries the full change since the last
 * applied state instead.
 */
export async function supersedePendingStockDeltas(
  tenantId: string,
  masterProductId: string,
  attribute: SyncAttribute,
): Promise<Map<string, number>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, payload')
    .eq('tenant_id', tenantId)
    .eq('master_product_id', masterProductId)
    .eq('attribute', attribute)
    .eq('status', 'pending');
  if (error) throw new Error(`Failed to read pending proposals: ${error.message}`);
  const rows = (data as Array<{ id: string; payload: SyncProposalPayload }> | null) ?? [];
  const summed = new Map<string, number>();
  const ids: string[] = [];
  for (const r of rows) {
    ids.push(r.id);
    for (const d of r.payload?.internalDeltas ?? []) {
      summed.set(d.internalSkuId, (summed.get(d.internalSkuId) ?? 0) + d.delta);
    }
  }
  if (ids.length > 0) {
    const { error: upErr } = await supabase.from(TABLE).update({ status: 'expired' }).in('id', ids);
    if (upErr) throw new Error(`Failed to expire superseded proposals: ${upErr.message}`);
  }
  return summed;
}

export async function markProposal(id: string, status: SyncProposalStatus): Promise<void> {
  const row: Record<string, unknown> = { status };
  if (status === 'applied') row.applied_at = new Date().toISOString();
  const { error } = await getSupabase().from(TABLE).update(row).eq('id', id);
  if (error) throw new Error(`Failed to update sync proposal: ${error.message}`);
}
