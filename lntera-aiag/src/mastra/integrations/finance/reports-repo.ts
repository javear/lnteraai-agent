// Phase 4 read models over posted journal entries: trial balance (Neraca Saldo), general ledger, and a
// P&L summary. Aggregation is done in TS over fetched lines (fine for SME volumes; revisit with a SQL
// view/materialized aggregate if a tenant's ledger grows large).
import { getSupabase } from '../shared/supabase';

interface RawLine {
  debit: number | string;
  credit: number | string;
  account_code: string;
  journal_entries: { date: string } | null;
  chart_of_accounts: { code: string; name: string; type: string; normal_balance: string } | null;
}

async function fetchPostedLines(tenantId: string, upTo?: string): Promise<RawLine[]> {
  let q = getSupabase()
    .from('journal_lines')
    .select('debit, credit, account_code, journal_entries!inner(date, status, tenant_id), chart_of_accounts!inner(code, name, type, normal_balance)')
    .eq('tenant_id', tenantId)
    .eq('journal_entries.status', 'posted');
  if (upTo) q = q.lte('journal_entries.date', upTo);
  const { data, error } = await q.limit(100000);
  if (error) throw new Error(`Failed to load journal lines: ${error.message}`);
  return (data as unknown as RawLine[]) ?? [];
}

const n = (v: number | string) => Number(v) || 0;
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  opening: number; // signed in the account's normal-balance direction
  debit: number; // within the period
  credit: number; // within the period
  ending: number;
}

/** Neraca Saldo: opening (before `from`) + period debit/credit (within [from,to]) + ending, per account. */
export async function trialBalance(tenantId: string, from?: string, to?: string): Promise<TrialBalanceRow[]> {
  const lines = await fetchPostedLines(tenantId, to);
  const byCode = new Map<string, TrialBalanceRow>();
  for (const l of lines) {
    const acct = l.chart_of_accounts;
    const date = l.journal_entries?.date;
    if (!acct || !date) continue;
    const row =
      byCode.get(acct.code) ??
      { code: acct.code, name: acct.name, type: acct.type, opening: 0, debit: 0, credit: 0, ending: 0 };
    const debit = n(l.debit);
    const credit = n(l.credit);
    const signed = acct.normal_balance === 'debit' ? debit - credit : credit - debit;
    if (from && date < from) {
      row.opening += signed;
    } else {
      row.debit += debit;
      row.credit += credit;
    }
    byCode.set(acct.code, row);
  }
  const rows = [...byCode.values()].map((r) => {
    const periodSigned = r.code && r.type ? (r.type === 'liability' || r.type === 'equity' || r.type === 'revenue' ? r.credit - r.debit : r.debit - r.credit) : 0;
    return { ...r, opening: round2(r.opening), debit: round2(r.debit), credit: round2(r.credit), ending: round2(r.opening + periodSigned) };
  });
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

export interface LedgerLine {
  date: string;
  entryId: string;
  debit: number;
  credit: number;
  description: string | null;
}

/** General ledger for one account (by code) within an optional date range. */
export async function generalLedger(tenantId: string, accountCode: string, from?: string, to?: string): Promise<LedgerLine[]> {
  let q = getSupabase()
    .from('journal_lines')
    .select('debit, credit, description, entry_id, journal_entries!inner(date, status)')
    .eq('tenant_id', tenantId)
    .eq('account_code', accountCode)
    .eq('journal_entries.status', 'posted');
  if (from) q = q.gte('journal_entries.date', from);
  if (to) q = q.lte('journal_entries.date', to);
  const { data, error } = await q.limit(100000);
  if (error) throw new Error(`Failed to load ledger: ${error.message}`);
  const rows = ((data as unknown as { debit: number | string; credit: number | string; description: string | null; entry_id: string; journal_entries: { date: string } }[]) ?? []).map((r) => ({
    date: r.journal_entries.date,
    entryId: r.entry_id,
    debit: n(r.debit),
    credit: n(r.credit),
    description: r.description,
  }));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export interface ProfitAndLoss {
  revenue: number;
  expense: number;
  net: number;
  byAccount: { code: string; name: string; type: string; amount: number }[];
}

/** Simple P&L for a period: revenue (credit−debit) − expense (debit−credit). */
export async function profitAndLoss(tenantId: string, from?: string, to?: string): Promise<ProfitAndLoss> {
  const tb = await trialBalance(tenantId, from, to);
  let revenue = 0;
  let expense = 0;
  const byAccount: ProfitAndLoss['byAccount'] = [];
  for (const r of tb) {
    if (r.type === 'revenue') {
      const amt = round2(r.credit - r.debit);
      revenue += amt;
      if (amt !== 0) byAccount.push({ code: r.code, name: r.name, type: r.type, amount: amt });
    } else if (r.type === 'expense') {
      const amt = round2(r.debit - r.credit);
      expense += amt;
      if (amt !== 0) byAccount.push({ code: r.code, name: r.name, type: r.type, amount: amt });
    }
  }
  return { revenue: round2(revenue), expense: round2(expense), net: round2(revenue - expense), byAccount };
}

interface ExportRow {
  date: string;
  entry_no: number;
  account_code: string;
  account_name: string;
  description: string | null;
  debit: number | string;
  credit: number | string;
}

/** Journal lines flattened for export (OWL-style): Tanggal, No. Jurnal, Nomor Akun, Nama Akun, Keterangan, Debet, Kredit. */
export async function journalExportRows(tenantId: string, from?: string, to?: string): Promise<ExportRow[]> {
  let q = getSupabase()
    .from('journal_lines')
    .select('debit, credit, description, account_code, chart_of_accounts!inner(name), journal_entries!inner(date, entry_no, status)')
    .eq('tenant_id', tenantId)
    .eq('journal_entries.status', 'posted');
  if (from) q = q.gte('journal_entries.date', from);
  if (to) q = q.lte('journal_entries.date', to);
  const { data, error } = await q.limit(100000);
  if (error) throw new Error(`Failed to load export rows: ${error.message}`);
  const rows = ((data as unknown as {
    debit: number | string;
    credit: number | string;
    description: string | null;
    account_code: string;
    chart_of_accounts: { name: string };
    journal_entries: { date: string; entry_no: number };
  }[]) ?? []).map((r) => ({
    date: r.journal_entries.date,
    entry_no: r.journal_entries.entry_no,
    account_code: r.account_code,
    account_name: r.chart_of_accounts?.name ?? '',
    description: r.description,
    debit: r.debit,
    credit: r.credit,
  }));
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.entry_no - b.entry_no);
  return rows;
}
