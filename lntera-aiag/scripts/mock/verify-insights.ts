// Verifies the insights engine + delivery WITHOUT live shop APIs: feed fixture orders/products to
// every provider, assert each produces a chart + sane metrics, then deliver via the real notifier so
// the message + charts persist to the tenant's Notifications thread (inspect with Supabase MCP after).
//   npx tsx scripts/mock/verify-insights.ts [tenantId]
import { loadLocalEnv } from './mock-env';

const TENANT = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a)) ?? 'dead0000-0000-4000-8000-00000000d001';

loadLocalEnv();

// Wire a storage provider onto generalAgent's Memory so the notification persists (same as the
// product-sync mock harness) — without importing the full server/Discord side effects.
const { Mastra } = await import('@mastra/core');
const { PostgresStore } = await import('@mastra/pg');
const { generalAgent } = await import('../../src/mastra/agents/general-agent');
if (process.env.DATABASE_URL) {
  new Mastra({
    agents: { generalAgent },
    storage: new PostgresStore({ id: 'verify-insights', connectionString: process.env.DATABASE_URL, schemaName: 'mastra', max: 4 }),
  });
}

const { INSIGHT_PROVIDERS } = await import('../../src/mastra/insights/providers');
const { notifyTenantOfInsights } = await import('../../src/mastra/active-mode/insight-notifier');
type AnyResult = Awaited<ReturnType<(typeof INSIGHT_PROVIDERS)[number]['compute']>>;

const now = new Date();
const hAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

// 10 orders: 6 unprocessed (3 pending / 2 processing / 1 processed), 2 cancelled, 2 completed.
// Items drive demand; products below define stock so the restock insights fire.
const orders = [
  { platform: 'shopee', shopId: 's', orderId: 'o1', status: 'pending', createdAt: hAgo(80), totalAmount: 50, items: [{ sku: 'SKU-A', name: 'Vitamin C 1000mg', quantity: 4 }] },
  { platform: 'shopee', shopId: 's', orderId: 'o2', status: 'pending', createdAt: hAgo(60), totalAmount: 30, items: [{ sku: 'SKU-A', name: 'Vitamin C 1000mg', quantity: 3 }] },
  { platform: 'shopee', shopId: 's', orderId: 'o3', status: 'pending', createdAt: hAgo(10), totalAmount: 20, items: [{ sku: 'SKU-B', name: 'Fish Oil', quantity: 2 }] },
  { platform: 'tiktok', shopId: 't', orderId: 'o4', status: 'processing', createdAt: hAgo(50), totalAmount: 40, items: [{ sku: 'SKU-B', name: 'Fish Oil', quantity: 5 }] },
  { platform: 'tiktok', shopId: 't', orderId: 'o5', status: 'processing', createdAt: hAgo(26), totalAmount: 60, items: [{ sku: 'SKU-C', name: 'Mug', quantity: 1 }] },
  { platform: 'shopee', shopId: 's', orderId: 'o6', status: 'processed', createdAt: hAgo(5), totalAmount: 15, items: [{ sku: 'SKU-A', name: 'Vitamin C 1000mg', quantity: 2 }] },
  { platform: 'shopee', shopId: 's', orderId: 'o7', status: 'cancelled', createdAt: hAgo(30), totalAmount: 25, items: [{ sku: 'SKU-C', name: 'Mug', quantity: 1 }] },
  { platform: 'tiktok', shopId: 't', orderId: 'o8', status: 'cancelled', createdAt: hAgo(20), totalAmount: 35, items: [{ sku: 'SKU-B', name: 'Fish Oil', quantity: 1 }] },
  { platform: 'shopee', shopId: 's', orderId: 'o9', status: 'completed', createdAt: hAgo(40), totalAmount: 45, items: [{ sku: 'SKU-A', name: 'Vitamin C 1000mg', quantity: 1 }] },
  { platform: 'tiktok', shopId: 't', orderId: 'o10', status: 'delivered', createdAt: hAgo(70), totalAmount: 55, items: [{ sku: 'SKU-C', name: 'Mug', quantity: 2 }] },
];
const products = [
  { platform: 'shopee', shopId: 's', productId: 'p-a', title: 'Vitamin C 1000mg', status: 'active', totalAvailableStock: 0, skus: [{ sellerSku: 'SKU-A', quantity: 0 }] },
  { platform: 'tiktok', shopId: 't', productId: 'p-b', title: 'Fish Oil', status: 'active', totalAvailableStock: 5, skus: [{ sellerSku: 'SKU-B', quantity: 5 }] },
  { platform: 'tiktok', shopId: 't', productId: 'p-c', title: 'Mug', status: 'active', totalAvailableStock: 100, skus: [{ sellerSku: 'SKU-C', quantity: 100 }] },
];

const data = {
  orders: orders as never,
  products: products as never,
  windowFrom: Math.floor(now.getTime() / 1000) - 14 * 86400,
  windowTo: Math.floor(now.getTime() / 1000),
  truncated: false,
  hasOrderItems: true,
  hasProducts: true,
  errors: [],
};

console.log('── Provider results (fixture data) ──');
const results: AnyResult[] = [];
let failures = 0;
for (const provider of INSIGHT_PROVIDERS) {
  const r = await provider.compute({ tenantId: TENANT, now, data });
  results.push(r);
  const chart = r.chart ? `${r.chart.type}[${r.chart.labels.length}]` : 'none';
  console.log(`  ${r.key.padEnd(28)} status=${r.status.padEnd(7)} chart=${chart.padEnd(10)} ${JSON.stringify(r.metrics)}`);
  if ((r.status === 'ok' || r.status === 'partial') && !r.chart) {
    console.error(`    ✗ expected a chart for ${r.key}`);
    failures++;
  }
}

// Spot-check the key numbers.
const unproc = results.find((r) => r.key === 'orders-unprocessed');
if (unproc?.metrics.unprocessed !== 6) { console.error(`✗ unprocessed expected 6, got ${unproc?.metrics.unprocessed}`); failures++; }
const cancel = results.find((r) => r.key === 'cancellation-rate');
if (cancel?.metrics.cancelled !== 2 || cancel?.metrics.total !== 10) { console.error(`✗ cancellation expected 2/10, got ${cancel?.metrics.cancelled}/${cancel?.metrics.total}`); failures++; }
const restock = results.find((r) => r.key === 'high-demand-not-restocked');
if ((restock?.metrics.outOfStockSellers ?? 0) < 1) { console.error('✗ expected ≥1 out-of-stock seller (SKU-A)'); failures++; }

console.log(`\nProvider checks: ${failures === 0 ? 'PASS ✅' : `${failures} FAILURE(S) ✗`}`);

console.log('\n── Delivering to the Active Agent (charts persist to the Notifications thread) ──');
const delivered = await notifyTenantOfInsights(TENANT, { status: 'ok', results, errors: [] });
console.log('  deliver:', JSON.stringify(delivered));
console.log(`  thread:  web:${TENANT}:notifications`);
console.log('\nInspect persisted charts:');
console.log(`  select (content::jsonb)->'metadata'->>'kind' kind, jsonb_array_length((content::jsonb)->'metadata'->'charts') charts`);
console.log(`  from mastra.mastra_messages where thread_id = 'web:${TENANT}:notifications' order by "createdAt" desc limit 1;`);

process.exit(failures === 0 ? 0 : 1);
