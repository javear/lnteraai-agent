// Canonical transaction store (Phase 1). Always-on: every tenant records here regardless of the
// advanced-finance toggle. External transactions are idempotent per (tenant, source, external_id) — a
// re-delivered webhook/API call UPDATES the existing row + replaces its lines rather than duplicating.
import { getSupabase } from '../shared/supabase';

export type TransactionSource = 'marketplace' | 'internal' | 'manual';
export type LineKind = 'product' | 'service' | 'fee' | 'tax' | 'shipping' | 'discount' | 'adjustment';

export interface TransactionLineInput {
  lineKind: LineKind;
  itemRefType?: string | null;
  itemRefId?: string | null;
  externalLineId?: string | null;
  description?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  taxAmount?: number;
  metadata?: Record<string, unknown> | null;
}

export interface TransactionInput {
  tenantId: string;
  source: TransactionSource;
  marketplaceConnectionId?: string | null;
  platform?: string | null;
  /** Platform/source id — when set, makes the record idempotent for that (tenant, source). */
  externalId?: string | null;
  type: string; // sale | refund | fee | payout | service | expense | …
  status?: string;
  currency?: string;
  grossAmount?: number;
  feeAmount?: number;
  taxAmount?: number;
  netAmount?: number;
  occurredAt?: string; // ISO
  counterparty?: Record<string, unknown> | null;
  description?: string | null;
  rawPayload?: unknown;
  metadata?: Record<string, unknown> | null;
  lines?: TransactionLineInput[];
}

export interface RecordTransactionResult {
  id: string;
  /** false = idempotent hit: an existing (tenant, source, external_id) was updated instead of inserted. */
  created: boolean;
}

const num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function buildRow(input: TransactionInput) {
  const lines = input.lines ?? [];
  const sumLineAmounts = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const sumLineTax = lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0);
  const gross = num(input.grossAmount, sumLineAmounts);
  const fee = num(input.feeAmount, 0);
  const tax = num(input.taxAmount, sumLineTax);
  const net = num(input.netAmount, gross - fee);
  return {
    tenant_id: input.tenantId,
    source: input.source,
    marketplace_connection_id: input.marketplaceConnectionId ?? null,
    platform: input.platform ?? null,
    external_id: input.externalId ?? null,
    type: input.type,
    status: input.status ?? 'completed',
    currency: input.currency ?? 'IDR',
    gross_amount: gross,
    fee_amount: fee,
    tax_amount: tax,
    net_amount: net,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    counterparty: input.counterparty ?? null,
    description: input.description ?? null,
    raw_payload: (input.rawPayload as Record<string, unknown> | null | undefined) ?? null,
    metadata: input.metadata ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function findByExternal(tenantId: string, source: string, externalId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('tenant_transactions')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('source', source)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up transaction: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

async function replaceLines(tenantId: string, txnId: string, lines: TransactionLineInput[]): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('tenant_transaction_lines').delete().eq('transaction_id', txnId);
  if (lines.length === 0) return;
  const rows = lines.map((l) => ({
    transaction_id: txnId,
    tenant_id: tenantId,
    line_kind: l.lineKind,
    item_ref_type: l.itemRefType ?? null,
    item_ref_id: l.itemRefId ?? null,
    external_line_id: l.externalLineId ?? null,
    description: l.description ?? null,
    quantity: l.quantity ?? null,
    unit_price: l.unitPrice ?? null,
    amount: l.amount,
    tax_amount: l.taxAmount ?? 0,
    metadata: l.metadata ?? null,
  }));
  const { error } = await supabase.from('tenant_transaction_lines').insert(rows);
  if (error) throw new Error(`Failed to insert transaction lines: ${error.message}`);
}

/**
 * Record (or idempotently update) a transaction + its lines. Returns the id and whether it was newly
 * created. The partial unique index is read-then-write (PostgREST can't infer a partial index for upsert),
 * with a 23505 fallback so a concurrent re-delivery resolves to an update instead of erroring.
 */
export async function recordTransaction(input: TransactionInput): Promise<RecordTransactionResult> {
  const supabase = getSupabase();
  const row = buildRow(input);
  const lines = input.lines ?? [];

  if (input.externalId) {
    const existingId = await findByExternal(input.tenantId, input.source, input.externalId);
    if (existingId) {
      const { error } = await supabase.from('tenant_transactions').update(row).eq('id', existingId);
      if (error) throw new Error(`Failed to update transaction: ${error.message}`);
      await replaceLines(input.tenantId, existingId, lines);
      return { id: existingId, created: false };
    }
  }

  const { data, error } = await supabase.from('tenant_transactions').insert(row).select('id').single();
  if (error) {
    // Lost an insert race on the unique (tenant, source, external_id) → fall back to update.
    if (error.code === '23505' && input.externalId) {
      const existingId = await findByExternal(input.tenantId, input.source, input.externalId);
      if (existingId) {
        await supabase.from('tenant_transactions').update(row).eq('id', existingId);
        await replaceLines(input.tenantId, existingId, lines);
        return { id: existingId, created: false };
      }
    }
    throw new Error(`Failed to insert transaction: ${error.message}`);
  }
  const id = (data as { id: string }).id;
  await replaceLines(input.tenantId, id, lines);
  return { id, created: true };
}
