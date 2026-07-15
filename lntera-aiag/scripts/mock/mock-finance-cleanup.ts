// Remove dummy finance data created by mock-finance-seed.ts. Identifies mock rows by
// tenant_transactions.metadata->>'seed' = 'finance-dummy-v1' (see mock-finance-seed.ts), and removes
// their projected journal entries/lines via source_transaction_id before deleting the transactions
// themselves (journal_lines cascades from its journal_entries FK).
//
//   npx tsx scripts/mock/mock-finance-cleanup.ts <tenantId>
import { isUuid, loadLocalEnv } from './mock-env';

const SEED_TAG = 'finance-dummy-v1';

async function main() {
  const tenantId = process.argv[2];
  if (!isUuid(tenantId)) {
    console.error('Usage: npx tsx scripts/mock/mock-finance-cleanup.ts <tenantId>');
    process.exit(1);
  }

  loadLocalEnv();
  const { getSupabase } = await import('../../src/mastra/integrations/shared/supabase');
  const supabase = getSupabase();

  const { data: txns, error: txnErr } = await supabase
    .from('tenant_transactions')
    .select('id, journal_entry_id')
    .eq('tenant_id', tenantId)
    .contains('metadata', { seed: SEED_TAG });
  if (txnErr) throw new Error(`read mock transactions failed: ${txnErr.message}`);
  const rows = (txns ?? []) as Array<{ id: string; journal_entry_id: string | null }>;
  if (rows.length === 0) {
    console.log('No mock finance data found for this tenant — nothing to clean.');
    return;
  }

  const entryIds = rows.map((r) => r.journal_entry_id).filter((id): id is string => !!id);
  if (entryIds.length) {
    const { error: entryErr, count } = await supabase
      .from('journal_entries')
      .delete({ count: 'exact' })
      .in('id', entryIds);
    if (entryErr) throw new Error(`delete journal_entries failed: ${entryErr.message}`);
    console.log(`  deleted journal_entries: ${count ?? entryIds.length} (journal_lines cascaded)`);
  }

  const txnIds = rows.map((r) => r.id);
  const { error: delErr, count: delCount } = await supabase
    .from('tenant_transactions')
    .delete({ count: 'exact' })
    .in('id', txnIds);
  if (delErr) throw new Error(`delete tenant_transactions failed: ${delErr.message}`);
  console.log(`  deleted tenant_transactions: ${delCount ?? txnIds.length}`);

  console.log('\nCleanup complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('mock-finance-cleanup failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
