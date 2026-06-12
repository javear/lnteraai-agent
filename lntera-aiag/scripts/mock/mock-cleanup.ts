// Remove ALL mock product-sync data created by mock-product-sync.ts. Identifies mock data by the
// mock marketplace_connections marker (external_shop_id `MOCK-…`, raw_metadata {mock:true}).
//
//   npx tsx scripts/mock/mock-cleanup.ts <tenantId>          clean one tenant
//   npx tsx scripts/mock/mock-cleanup.ts --all               clean every mock tenant
//   [--keep-prefs]            don't reset that tenant's tenant_sync_prefs (the sim toggled them)
//   [--purge-notifications]   also delete product_sync messages from the Notifications chat thread
//
// Order matters: tenant_products.source_connection_id is ON DELETE SET NULL (not cascade), so we
// delete products BEFORE the mock connection. SKUs + inventory cascade from the product delete;
// product_mappings cascade from the connection delete (we also delete them explicitly).
import { isUuid, loadLocalEnv } from './mock-env';

async function count(promise: Promise<{ data: unknown[] | null; error: unknown }>): Promise<number> {
  const { data, error } = await promise;
  if (error) throw new Error(typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error));
  return data?.length ?? 0;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const keepPrefs = args.includes('--keep-prefs');
  const purgeNotifications = args.includes('--purge-notifications');
  const tenantArg = args.find((a) => !a.startsWith('--'));

  if (!all && !isUuid(tenantArg)) {
    console.error('Usage: npx tsx scripts/mock/mock-cleanup.ts <tenantId> | --all [--keep-prefs] [--purge-notifications]');
    process.exit(1);
  }

  loadLocalEnv();
  const { getSupabase } = await import('../../src/mastra/integrations/shared/supabase');
  const supabase = getSupabase();

  // 1) Find mock connections (the marker for everything else).
  let connQuery = supabase
    .from('marketplace_connections')
    .select('id, tenant_id, platform, external_shop_id')
    .like('external_shop_id', 'MOCK-%')
    .contains('raw_metadata', { mock: true });
  if (!all) connQuery = connQuery.eq('tenant_id', tenantArg as string);

  const { data: conns, error: connErr } = await connQuery;
  if (connErr) throw new Error(`read mock connections failed: ${connErr.message}`);
  const mockConns = (conns ?? []) as Array<{ id: string; tenant_id: string }>;
  if (mockConns.length === 0) {
    console.log('No mock connections found — nothing to clean.');
    return;
  }
  const connIds = mockConns.map((c) => c.id);
  const tenantIds = [...new Set(mockConns.map((c) => c.tenant_id))];
  console.log(`Found ${mockConns.length} mock connection(s) across ${tenantIds.length} tenant(s).`);

  // 2) Products (cascades skus + inventory) — BEFORE deleting the connection (SET NULL FK).
  const products = await count(
    supabase.from('tenant_products').delete().in('source_connection_id', connIds).select('id'),
  );
  console.log(`  deleted tenant_products: ${products} (skus + inventory cascaded)`);

  // 3) Mappings (also cascade from the connection delete; explicit for clarity/count).
  const mappings = await count(
    supabase.from('product_mappings').delete().in('marketplace_connection_id', connIds).select('id'),
  );
  console.log(`  deleted product_mappings: ${mappings}`);

  // 4a) Explicitly-mock warehouses.
  let whQuery = supabase.from('tenant_warehouses').delete().like('external_warehouse_id', 'MOCK-WH-%').select('id');
  if (!all) whQuery = whQuery.eq('tenant_id', tenantArg as string);
  const mockWh = await count(whQuery);
  // 4b) Now-empty DEFAULT warehouses for affected tenants (synthetic Shopee default). Safe: an empty
  //     default warehouse holds no inventory and is auto-recreated on the next stock write.
  const { data: defWh } = await supabase.from('tenant_warehouses').select('id').in('tenant_id', tenantIds).eq('is_default', true);
  const defIds = ((defWh ?? []) as Array<{ id: string }>).map((w) => w.id);
  let emptyDefaults = 0;
  if (defIds.length) {
    const { data: used } = await supabase.from('tenant_inventory').select('warehouse_id').in('warehouse_id', defIds);
    const usedSet = new Set(((used ?? []) as Array<{ warehouse_id: string }>).map((r) => r.warehouse_id));
    const empty = defIds.filter((id) => !usedSet.has(id));
    if (empty.length) emptyDefaults = await count(supabase.from('tenant_warehouses').delete().in('id', empty).select('id'));
  }
  console.log(`  deleted tenant_warehouses: ${mockWh} mock + ${emptyDefaults} empty-default`);

  // 5) Reset the sync prefs the sim toggled (unless asked to keep).
  if (!keepPrefs) {
    const prefs = await count(supabase.from('tenant_sync_prefs').delete().in('tenant_id', tenantIds).select('id'));
    console.log(`  reset tenant_sync_prefs: ${prefs} (back to defaults: auto-create OFF, auto-map OFF, 0.90/0.60)`);
  } else {
    console.log('  kept tenant_sync_prefs (--keep-prefs)');
  }

  // 6) The mock connections themselves.
  const deletedConns = await count(supabase.from('marketplace_connections').delete().in('id', connIds).select('id'));
  console.log(`  deleted marketplace_connections (mock): ${deletedConns}`);

  // 7) Optional: purge product_sync notification messages from the Notifications thread(s).
  if (purgeNotifications) {
    try {
      const { generalAgent } = await import('../../src/mastra/agents/general-agent');
      const memory = await generalAgent.getMemory();
      if (!memory) {
        console.log('  notifications: memory unavailable — skipped.');
      } else {
        let purged = 0;
        for (const t of tenantIds) {
          const threadId = `web:${t}:notifications`;
          const recalled = await memory
            .recall({ threadId, resourceId: t, perPage: 500, page: 0, orderBy: { field: 'createdAt', direction: 'DESC' } })
            .catch(() => null);
          const ids = (recalled?.messages ?? [])
            .filter((m: { content?: unknown }) => {
              const meta = (m.content as { metadata?: { kind?: string } } | null)?.metadata;
              return meta?.kind === 'product_sync';
            })
            .map((m: { id: string }) => m.id);
          if (ids.length === 0) continue;
          const del = (memory as { deleteMessages?: (ids: string[]) => Promise<unknown> }).deleteMessages;
          if (typeof del === 'function') {
            await del.call(memory, ids);
            purged += ids.length;
          } else {
            console.log(`  notifications: memory.deleteMessages unavailable — ${ids.length} product_sync message(s) remain in ${threadId} (clear via UI).`);
          }
        }
        if (purged) console.log(`  purged product_sync notifications: ${purged}`);
      }
    } catch (err) {
      console.log('  notifications purge skipped:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('  notifications: left in place (pass --purge-notifications to remove product_sync messages).');
  }

  console.log('\nCleanup complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('mock-cleanup failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
