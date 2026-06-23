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

export interface SyncProposalPayload {
  productTitle: string;
  sourceSummary: string;
  targets: SyncProposalTarget[];
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

export async function markProposal(id: string, status: SyncProposalStatus): Promise<void> {
  const row: Record<string, unknown> = { status };
  if (status === 'applied') row.applied_at = new Date().toISOString();
  const { error } = await getSupabase().from(TABLE).update(row).eq('id', id);
  if (error) throw new Error(`Failed to update sync proposal: ${error.message}`);
}
