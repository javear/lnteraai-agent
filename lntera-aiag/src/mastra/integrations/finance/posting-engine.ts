// Projects a transaction into a balanced double-entry journal entry using the tenant's posting rules.
// Gated by the advanced-finance toggle (maybePostTransaction is a no-op when accounting is off).
import { getSupabase } from '../shared/supabase';
import { logErrorBrief } from '../../logger/compact-error';
import { getFinanceSettings } from './finance-settings-repo';
import { getTaxConfig } from './tax-config-repo';
import { createJournalEntry, type JournalLineInput } from './accounting-repo';
import { SUSPENSE_CODE } from './accounting-defaults';

// Sale-type transactions whose revenue is PPN-inclusive when the tenant is PPN-registered.
const SALE_TYPES = new Set(['sale', 'marketplace_sale', 'service']);
const PPN_OUTPUT_CODE = '2200';

interface TxnRow {
  id: string;
  type: string;
  currency: string;
  gross_amount: number | string;
  net_amount: number | string;
  fee_amount: number | string;
  tax_amount: number | string;
  occurred_at: string;
  description: string | null;
  external_id: string | null;
  posted: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function amountFor(txn: TxnRow, source: string): number {
  switch (source) {
    case 'gross':
      return Number(txn.gross_amount) || 0;
    case 'net':
      return Number(txn.net_amount) || 0;
    case 'fee':
      return Number(txn.fee_amount) || 0;
    case 'tax':
      return Number(txn.tax_amount) || 0;
    default:
      return 0; // shipping/discount sourced from lines in a later phase
  }
}

export type PostStatus = 'posted' | 'already' | 'no_rules' | 'unbalanced' | 'not_found' | 'zero';

/** Post only if the tenant has advanced finance enabled. Non-fatal — never breaks the ingest path. */
export async function maybePostTransaction(tenantId: string, txnId: string): Promise<void> {
  try {
    const settings = await getFinanceSettings(tenantId);
    if (!settings.accountingEnabled) return;
    await postTransaction(tenantId, txnId);
  } catch (err) {
    logErrorBrief('[accounting] auto-post failed', err);
  }
}

export async function postTransaction(tenantId: string, txnId: string): Promise<{ status: PostStatus; entryId?: string }> {
  const supabase = getSupabase();
  const { data: txnData, error: txnErr } = await supabase
    .from('tenant_transactions')
    .select('id, type, currency, gross_amount, net_amount, fee_amount, tax_amount, occurred_at, description, external_id, posted')
    .eq('id', txnId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (txnErr) throw new Error(`Failed to load transaction: ${txnErr.message}`);
  if (!txnData) return { status: 'not_found' };
  const txn = txnData as TxnRow;
  if (txn.posted) return { status: 'already' };

  const { data: rules } = await supabase
    .from('posting_rules')
    .select('account_id, side, amount_source')
    .eq('tenant_id', tenantId)
    .eq('transaction_type', txn.type)
    .order('sequence', { ascending: true });
  if (!rules || rules.length === 0) return { status: 'no_rules' }; // unmapped type → left unposted for review

  const { data: coa } = await supabase.from('chart_of_accounts').select('id, code, type').eq('tenant_id', tenantId);
  const coaRows = (coa as { id: string; code: string; type: string }[] | null) ?? [];
  const codeById = new Map(coaRows.map((r) => [r.id, r.code]));
  const idByCode = new Map(coaRows.map((r) => [r.code, r.id]));
  const typeByCode = new Map(coaRows.map((r) => [r.code, r.type]));

  const lines: JournalLineInput[] = [];
  for (const r of rules as { account_id: string; side: string; amount_source: string }[]) {
    const amt = round2(amountFor(txn, r.amount_source));
    if (amt === 0) continue;
    const code = codeById.get(r.account_id);
    if (!code) continue;
    lines.push({
      accountId: r.account_id,
      accountCode: code,
      debit: r.side === 'debit' ? amt : 0,
      credit: r.side === 'credit' ? amt : 0,
      description: txn.description ?? txn.type,
    });
  }
  if (lines.length === 0) return { status: 'zero' };

  // Tax-aware posting: if the tenant is PPN-registered, split output VAT out of sale revenue. Default is
  // PPN-INCLUSIVE pricing (the common Indonesian case): ppn = revenue × rate/(100+rate). Balance-neutral —
  // total credit is unchanged (revenue−ppn moves to PPN Keluaran). Configurable per tenant; adjust later.
  if (SALE_TYPES.has(txn.type)) {
    const taxCfg = await getTaxConfig(tenantId).catch(() => ({ config: {} as Record<string, unknown> }));
    const cfg = taxCfg.config as { ppnEnabled?: boolean; ppnRate?: number };
    const ppnAccountId = idByCode.get(PPN_OUTPUT_CODE);
    if (cfg.ppnEnabled && ppnAccountId) {
      const rate = Number(cfg.ppnRate) || 11;
      let ppnTotal = 0;
      for (const l of lines) {
        if (l.credit > 0 && typeByCode.get(l.accountCode) === 'revenue') {
          const ppn = round2((l.credit * rate) / (100 + rate));
          l.credit = round2(l.credit - ppn);
          ppnTotal = round2(ppnTotal + ppn);
        }
      }
      if (ppnTotal > 0) {
        lines.push({ accountId: ppnAccountId, accountCode: PPN_OUTPUT_CODE, debit: 0, credit: ppnTotal, description: `PPN ${rate}% (inclusive)` });
      }
    }
  }

  // Auto-balance any rounding/rule gap into the suspense account so the entry always balances.
  const diff = round2(lines.reduce((s, l) => s + l.debit, 0) - lines.reduce((s, l) => s + l.credit, 0));
  if (diff !== 0) {
    const suspenseId = idByCode.get(SUSPENSE_CODE);
    if (!suspenseId) return { status: 'unbalanced' };
    lines.push({
      accountId: suspenseId,
      accountCode: SUSPENSE_CODE,
      debit: diff < 0 ? -diff : 0,
      credit: diff > 0 ? diff : 0,
      description: 'Auto-balance (suspense)',
    });
  }

  const res = await createJournalEntry({
    tenantId,
    date: (txn.occurred_at ?? new Date().toISOString()).slice(0, 10),
    description: txn.description ?? `${txn.type}${txn.external_id ? ` ${txn.external_id}` : ''}`,
    sourceTransactionId: txnId,
    currency: txn.currency,
    createdBy: 'system',
    lines,
  });
  if ('error' in res) {
    logErrorBrief('[accounting] entry rejected', res.error);
    return { status: 'unbalanced' };
  }
  await supabase.from('tenant_transactions').update({ posted: true, journal_entry_id: res.id }).eq('id', txnId);
  return { status: 'posted', entryId: res.id };
}

/** Post all not-yet-posted transactions for a tenant (used right after enabling accounting). */
export async function backfillUnposted(tenantId: string, limit = 500): Promise<{ posted: number; skipped: number }> {
  const { data } = await getSupabase()
    .from('tenant_transactions')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('posted', false)
    .order('occurred_at', { ascending: true })
    .limit(limit);
  let posted = 0;
  let skipped = 0;
  for (const row of (data as { id: string }[] | null) ?? []) {
    const r = await postTransaction(tenantId, row.id).catch(() => ({ status: 'unbalanced' as PostStatus }));
    if (r.status === 'posted') posted++;
    else skipped++;
  }
  return { posted, skipped };
}
