// Tax recap for a period, derived from the posted ledger (every figure traceable to journal entries):
// PPN output (2200 credits) vs input (1500 debits), and PPh withholding payable (2310–2340 credits).
// Reflects whatever tax has actually been posted; tax-aware posting (auto PPN split, per-supplier bukti
// potong) is the next refinement once a tenant's tax config + a Coretax sample are confirmed.
import { trialBalance } from './reports-repo';
import { getTaxConfig } from './tax-config-repo';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface TaxRecap {
  from?: string;
  to?: string;
  npwp: string | null;
  ppn: { output: number; input: number; payable: number };
  withholding: { code: string; label: string; amount: number }[];
}

const WITHHOLDING_ACCOUNTS = [
  { code: '2310', label: 'PPh 21' },
  { code: '2320', label: 'PPh 23' },
  { code: '2330', label: 'PPh Final 4(2)' },
  { code: '2340', label: 'PPh 25/29' },
];

export async function taxRecap(tenantId: string, from?: string, to?: string): Promise<TaxRecap> {
  const tb = await trialBalance(tenantId, from, to);
  const byCode = new Map(tb.map((r) => [r.code, r]));
  const output = round2(byCode.get('2200')?.credit ?? 0);
  const input = round2(byCode.get('1500')?.debit ?? 0);
  const withholding = WITHHOLDING_ACCOUNTS.map((w) => ({ ...w, amount: round2(byCode.get(w.code)?.credit ?? 0) })).filter(
    (w) => w.amount !== 0,
  );
  const cfg = await getTaxConfig(tenantId);
  return { from, to, npwp: cfg.npwp, ppn: { output, input, payable: round2(output - input) }, withholding };
}
