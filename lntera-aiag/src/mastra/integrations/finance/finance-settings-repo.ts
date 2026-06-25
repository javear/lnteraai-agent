// Per-tenant advanced-finance toggle + default seeding. Accounting/tax are OFF by default; enabling
// seeds the editable default chart of accounts + posting rules (idempotent).
import { getSupabase } from '../shared/supabase';
import { DEFAULT_COA, DEFAULT_POSTING_RULES } from './accounting-defaults';

export interface FinanceSettings {
  accountingEnabled: boolean;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}

const DEFAULTS: FinanceSettings = { accountingEnabled: false, baseCurrency: 'IDR', fiscalYearStartMonth: 1 };

export async function getFinanceSettings(tenantId: string): Promise<FinanceSettings> {
  const { data, error } = await getSupabase()
    .from('tenant_finance_settings')
    .select('accounting_enabled, base_currency, fiscal_year_start_month')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read finance settings: ${error.message}`);
  if (!data) return { ...DEFAULTS };
  const r = data as { accounting_enabled?: boolean; base_currency?: string; fiscal_year_start_month?: number };
  return {
    accountingEnabled: Boolean(r.accounting_enabled),
    baseCurrency: r.base_currency ?? 'IDR',
    fiscalYearStartMonth: r.fiscal_year_start_month ?? 1,
  };
}

/** Enable/disable advanced finance. Enabling seeds the default COA + posting rules (idempotent). */
export async function setAccountingEnabled(tenantId: string, enabled: boolean): Promise<void> {
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('tenant_finance_settings')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from('tenant_finance_settings')
      .update({ accounting_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId);
    if (error) throw new Error(`Failed to update finance settings: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('tenant_finance_settings')
      .insert({ tenant_id: tenantId, accounting_enabled: enabled });
    if (error) throw new Error(`Failed to create finance settings: ${error.message}`);
  }
  if (enabled) await seedDefaultAccounting(tenantId);
}

/**
 * Seed the default chart of accounts (if none) + top up any MISSING default posting rules. Idempotent +
 * additive — re-running picks up newly-shipped default rules (e.g. the marketplace flow) without
 * duplicating or clobbering a tenant's edits.
 */
export async function seedDefaultAccounting(tenantId: string): Promise<void> {
  const supabase = getSupabase();

  // 1) Chart of accounts — insert the default set only if the tenant has none.
  const { data: existingCoa, error: coaCheckErr } = await supabase
    .from('chart_of_accounts')
    .select('id, code')
    .eq('tenant_id', tenantId);
  if (coaCheckErr) throw new Error(`Failed to check chart of accounts: ${coaCheckErr.message}`);
  let coa = (existingCoa as { id: string; code: string }[]) ?? [];
  if (coa.length === 0) {
    const coaRows = DEFAULT_COA.map((a) => ({
      tenant_id: tenantId,
      code: a.code,
      name: a.name,
      type: a.type,
      normal_balance: a.normalBalance,
    }));
    const { data: inserted, error: coaErr } = await supabase.from('chart_of_accounts').insert(coaRows).select('id, code');
    if (coaErr) throw new Error(`Failed to seed chart of accounts: ${coaErr.message}`);
    coa = (inserted as { id: string; code: string }[]) ?? [];
  }
  const idByCode = new Map(coa.map((r) => [r.code, r.id]));

  // 2) Posting rules — add any default rule not already present (by type + account + side).
  const { data: existingRules } = await supabase
    .from('posting_rules')
    .select('transaction_type, account_id, side')
    .eq('tenant_id', tenantId);
  const have = new Set(
    ((existingRules as { transaction_type: string; account_id: string; side: string }[]) ?? []).map(
      (r) => `${r.transaction_type}|${r.account_id}|${r.side}`,
    ),
  );
  const ruleRows = DEFAULT_POSTING_RULES.map((r) => ({
    tenant_id: tenantId,
    transaction_type: r.transactionType,
    sequence: r.sequence,
    account_id: idByCode.get(r.accountCode) ?? null,
    side: r.side,
    amount_source: r.amountSource,
  })).filter((r) => r.account_id && !have.has(`${r.transaction_type}|${r.account_id}|${r.side}`));
  if (ruleRows.length > 0) {
    const { error: ruleErr } = await supabase.from('posting_rules').insert(ruleRows);
    if (ruleErr) throw new Error(`Failed to seed posting rules: ${ruleErr.message}`);
  }
}
