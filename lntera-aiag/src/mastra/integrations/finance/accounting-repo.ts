// Double-entry write + read helpers. Every entry must balance (Σ debit = Σ credit) and have ≥2 lines.
import { getSupabase } from '../shared/supabase';

export interface JournalLineInput {
  accountId: string;
  accountCode: string;
  debit: number;
  credit: number;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateJournalEntryInput {
  tenantId: string;
  date?: string; // YYYY-MM-DD
  description?: string | null;
  sourceTransactionId?: string | null;
  currency?: string;
  createdBy?: string;
  lines: JournalLineInput[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Insert a balanced journal entry + its lines. Returns `{ id }` or `{ error }` (never writes if unbalanced). */
export async function createJournalEntry(
  input: CreateJournalEntryInput,
): Promise<{ id: string } | { error: string }> {
  const lines = input.lines.filter((l) => round2(l.debit) > 0 || round2(l.credit) > 0);
  if (lines.length < 2) return { error: 'A journal entry needs at least two lines.' };
  const debit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const credit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  if (debit !== credit) return { error: `Unbalanced entry (debit ${debit} ≠ credit ${credit}).` };
  if (debit === 0) return { error: 'A journal entry cannot be zero.' };

  const supabase = getSupabase();
  const { data: entry, error: entryErr } = await supabase
    .from('journal_entries')
    .insert({
      tenant_id: input.tenantId,
      date: input.date ?? new Date().toISOString().slice(0, 10),
      source_transaction_id: input.sourceTransactionId ?? null,
      description: input.description ?? null,
      currency: input.currency ?? 'IDR',
      created_by: input.createdBy ?? 'system',
      status: 'posted',
    })
    .select('id')
    .single();
  if (entryErr) return { error: `Failed to create journal entry: ${entryErr.message}` };
  const entryId = (entry as { id: string }).id;

  const lineRows = lines.map((l) => ({
    entry_id: entryId,
    tenant_id: input.tenantId,
    account_id: l.accountId,
    account_code: l.accountCode,
    debit: round2(l.debit || 0),
    credit: round2(l.credit || 0),
    description: l.description ?? null,
    metadata: l.metadata ?? null,
  }));
  const { error: lineErr } = await supabase.from('journal_lines').insert(lineRows);
  if (lineErr) {
    await supabase.from('journal_entries').delete().eq('id', entryId); // roll back the header
    return { error: `Failed to create journal lines: ${lineErr.message}` };
  }
  return { id: entryId };
}

/** Map of account code → { id, code } for a tenant (for resolving posting rules + suspense). */
export async function getAccountMap(tenantId: string): Promise<Map<string, { id: string; code: string }>> {
  const { data, error } = await getSupabase()
    .from('chart_of_accounts')
    .select('id, code')
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to load chart of accounts: ${error.message}`);
  const map = new Map<string, { id: string; code: string }>();
  for (const r of (data as { id: string; code: string }[]) ?? []) map.set(r.code, { id: r.id, code: r.code });
  return map;
}
