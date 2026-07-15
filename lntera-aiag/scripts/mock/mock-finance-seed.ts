// Seed dummy transactions + project them into the general ledger for a tenant that already has
// advanced finance enabled (chart of accounts + posting rules set up). Uses the REAL posting engine
// (postTransaction) against the LIVE DB so the resulting journal entries are exactly what production
// would produce for these transaction types — not a hand-rolled approximation.
//
//   npx tsx scripts/mock/mock-finance-seed.ts <tenantId> [count]
//
//   <tenantId>   a real tenant_master UUID with tenant_finance_settings.accounting_enabled = true
//   [count]      how many transactions to generate (default 24)
//
// Every row is tagged metadata.mock = true / metadata.seed = 'finance-dummy-v1' so
// mock-finance-cleanup.ts can find and remove exactly this seeded data later.
import { isUuid, loadLocalEnv } from './mock-env';

const SEED_TAG = 'finance-dummy-v1';

// Mapped by this tenant's posting_rules (sale, service, refund, expense) — anything else is left
// unposted by the engine ('no_rules'), so stick to what's actually wired up.
const TYPE_WEIGHTS: Array<{ type: string; weight: number; min: number; max: number; descriptions: string[] }> = [
  {
    type: 'sale',
    weight: 14,
    min: 150_000,
    max: 2_500_000,
    descriptions: ['Penjualan produk retail', 'Penjualan online marketplace', 'Penjualan grosir', 'Penjualan toko'],
  },
  {
    type: 'service',
    weight: 4,
    min: 300_000,
    max: 1_500_000,
    descriptions: ['Jasa konsultasi', 'Jasa instalasi', 'Jasa perbaikan', 'Jasa pengiriman khusus'],
  },
  {
    type: 'refund',
    weight: 3,
    min: 50_000,
    max: 300_000,
    descriptions: ['Retur barang rusak', 'Retur salah kirim', 'Pembatalan pesanan'],
  },
  {
    type: 'expense',
    weight: 3,
    min: 100_000,
    max: 800_000,
    descriptions: ['Beban listrik & air', 'Beban ATK', 'Beban transportasi', 'Beban sewa peralatan'],
  },
];

const COUNTERPARTIES = [
  'Toko Sinar Jaya', 'CV Makmur Abadi', 'Budi Santoso', 'PT Cahaya Mandiri', 'Siti Rahayu',
  'UD Berkah Sejahtera', 'Ahmad Fauzi', 'CV Sumber Rejeki', 'Dewi Lestari', 'PT Karya Utama',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedType(): (typeof TYPE_WEIGHTS)[number] {
  const total = TYPE_WEIGHTS.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of TYPE_WEIGHTS) {
    if (r < t.weight) return t;
    r -= t.weight;
  }
  return TYPE_WEIGHTS[0];
}

function randomAmount(min: number, max: number): number {
  // Round to the nearest 1,000 IDR — realistic for SME cash transactions.
  return Math.round((min + Math.random() * (max - min)) / 1000) * 1000;
}

/** Spread `count` occurred_at timestamps roughly evenly over the last `days`, oldest first. */
function spreadDates(count: number, days: number): Date[] {
  const now = Date.now();
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor((i / count) * days) + Math.floor(Math.random() * (days / count || 1));
    const jitterMs = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
    dates.push(new Date(now - (days - dayOffset) * 24 * 60 * 60 * 1000 - jitterMs));
  }
  return dates.sort((a, b) => a.getTime() - b.getTime());
}

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args[0];
  const count = Number(args[1]) || 24;

  if (!isUuid(tenantId)) {
    console.error('Usage: npx tsx scripts/mock/mock-finance-seed.ts <tenantId> [count]');
    console.error('  <tenantId> must be a tenant_master UUID with accounting_enabled = true.');
    process.exit(1);
  }

  loadLocalEnv();
  const { getSupabase } = await import('../../src/mastra/integrations/shared/supabase');
  const { getFinanceSettings } = await import('../../src/mastra/integrations/finance/finance-settings-repo');
  const { postTransaction } = await import('../../src/mastra/integrations/finance/posting-engine');
  const supabase = getSupabase();

  const settings = await getFinanceSettings(tenantId);
  if (!settings.accountingEnabled) {
    console.error(`Tenant ${tenantId} does not have accounting_enabled — enable it first (posting would be a no-op).`);
    process.exit(1);
  }

  const { data: rules } = await supabase.from('posting_rules').select('transaction_type').eq('tenant_id', tenantId);
  const mappedTypes = new Set(((rules ?? []) as { transaction_type: string }[]).map((r) => r.transaction_type));
  console.log(`Tenant ${tenantId} · posting rules cover: ${[...mappedTypes].join(', ') || '(none)'}`);

  const dates = spreadDates(count, 60);
  let posted = 0;
  let skipped = 0;

  for (let i = 0; i < count; i++) {
    const spec = weightedType();
    const amount = randomAmount(spec.min, spec.max);
    const occurredAt = dates[i];

    const { data: txn, error } = await supabase
      .from('tenant_transactions')
      .insert({
        tenant_id: tenantId,
        source: 'manual',
        type: spec.type,
        status: 'completed',
        currency: 'IDR',
        gross_amount: amount,
        fee_amount: 0,
        tax_amount: 0,
        net_amount: amount,
        occurred_at: occurredAt.toISOString(),
        counterparty: { name: pick(COUNTERPARTIES) },
        description: pick(spec.descriptions),
        metadata: { mock: true, seed: SEED_TAG },
      })
      .select('id')
      .single();
    if (error) {
      console.error(`  [${i + 1}/${count}] insert failed:`, error.message);
      skipped++;
      continue;
    }
    const txnId = (txn as { id: string }).id;

    const result = await postTransaction(tenantId, txnId);
    if (result.status === 'posted') {
      posted++;
      console.log(`  [${i + 1}/${count}] ${spec.type} Rp${amount.toLocaleString('id-ID')} on ${occurredAt.toISOString().slice(0, 10)} → posted`);
    } else {
      skipped++;
      console.log(`  [${i + 1}/${count}] ${spec.type} Rp${amount.toLocaleString('id-ID')} → NOT posted (${result.status})`);
    }
  }

  console.log(`\nDone: ${posted} transaction(s) posted to the ledger, ${skipped} skipped.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('mock-finance-seed failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
