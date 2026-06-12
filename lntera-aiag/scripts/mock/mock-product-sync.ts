// Simulate marketplace → catalog product-sync against the LIVE DB for a given tenant, WITHOUT
// touching any real marketplace store (synthetic product details feed the real pipeline).
//
//   npx tsx scripts/mock/mock-product-sync.ts <tenantId> [scenario] [--no-notify]
//
//   <tenantId>   a real tenant_master UUID (your tenant)
//   [scenario]   one of the scenario names, or "all" (default)
//   --no-notify  write to the DB but skip dispatching notifications (popup/push/Discord)
//
// Scenarios: new-ask, new-auto, high-ask, high-auto, medium, multi-warehouse, idempotent,
//            webhook-rescore, flood-batch, connect-offer, actions, all
import { isUuid, loadLocalEnv } from './mock-env';

async function main() {
  const args = process.argv.slice(2);
  const notify = !args.includes('--no-notify');
  const positional = args.filter((a) => !a.startsWith('--'));
  const tenantId = positional[0];
  const scenario = positional[1] ?? 'all';

  if (!isUuid(tenantId)) {
    console.error('Usage: npx tsx scripts/mock/mock-product-sync.ts <tenantId> [scenario] [--no-notify]');
    console.error('  <tenantId> must be a tenant_master UUID.');
    process.exit(1);
  }

  // Env first, THEN import the pipeline (modules read env at import time).
  loadLocalEnv();
  const { runScenarios, SCENARIO_NAMES } = await import('./mock-scenarios');

  if (scenario !== 'all' && !SCENARIO_NAMES.includes(scenario)) {
    console.error(`Unknown scenario "${scenario}". Available: ${SCENARIO_NAMES.join(', ')}, all`);
    process.exit(1);
  }

  console.log(`Mock product-sync · tenant=${tenantId} · scenario=${scenario} · notify=${notify}`);
  await runScenarios(tenantId, scenario, notify);
  // Notification dispatch may leave timers/handles; exit explicitly.
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('mock-product-sync failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
