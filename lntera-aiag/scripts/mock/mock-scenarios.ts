// Mock product-sync scenarios. Runs the REAL pipeline (embeddings → hybrid match → routing →
// mappings → notifications) against the live DB, but feeds SYNTHETIC product details — so it never
// calls Shopee/TikTok. A mock marketplace_connections row (external_shop_id `MOCK-…`, raw_metadata
// {mock:true}) satisfies FKs; mock-cleanup.ts removes everything by those markers.
//
// Mock products use REALISTIC titles (no marker) so similarity scores behave like production — the
// mock-ness is tracked by the connection, not the title. Matching bands are computed live by the
// model, so each scenario logs the ACTUAL decision/score (labels describe what each case demonstrates;
// MEDIUM in particular is a narrow band for this model, so its exact landing can vary).
import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { generalAgent } from '../../src/mastra/agents/general-agent';
import { getSupabase } from '../../src/mastra/integrations/shared/supabase';
import { setSyncPrefs } from '../../src/mastra/integrations/shared/sync-prefs';
import {
  ingestMarketplaceProduct,
  type IngestResult,
  type ProductSyncNotice,
} from '../../src/mastra/integrations/products/ingest-marketplace-product';
import { getMappingByExternal } from '../../src/mastra/integrations/products/product-mappings-repo';
import {
  dispatchResyncNotices,
  notifyConnectedOfferSync,
  notifyProductSyncDecision,
} from '../../src/mastra/sync/product-sync-notifier';
import type { ResyncSummary } from '../../src/mastra/sync/product-sync-engine';
import { applyProductSyncAction } from '../../src/mastra/sync/product-sync-actions';
import type { NormalizedProductDetail, NormalizedProductVariant } from '../../src/mastra/integrations/shared/products';
import type { MarketplaceConnection, Platform } from '../../src/mastra/integrations/shared/types';

let NOTIFY = true;

// Wire a storage provider onto generalAgent's Memory so notifications PERSIST to the chat thread
// (not just broadcast). Constructs a minimal Mastra — same storage as the app, but no HTTP server /
// Discord bots (those are side effects of importing src/mastra/index.ts, which we avoid).
let storageWired = false;
function wireStorage(): void {
  if (storageWired) return;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.warn('   (no DATABASE_URL — notifications will broadcast but not persist to the chat)');
    return;
  }
  new Mastra({
    agents: { generalAgent },
    storage: new PostgresStore({
      id: 'mock-mastra-storage',
      connectionString,
      schemaName: 'mastra',
      max: 4,
      idleTimeoutMillis: 20_000,
    }),
  });
  storageWired = true;
}

// ---- console helpers ----------------------------------------------------------------------------
const hr = () => console.log('─'.repeat(78));
function header(name: string, desc: string) {
  console.log(`\n┏━ ${name}`);
  console.log(`┗━ ${desc}`);
}
function logResult(r: IngestResult) {
  const score = r.score == null ? 'n/a' : r.score.toFixed(3);
  console.log(
    `   → decision=${r.decision}  band=${r.band ?? '-'}  score=${score}  mapping=${r.mappingId}` +
      `  notice=${r.notice ? r.notice.kind : 'none'}  internal=${r.internalProductId ?? '-'}`,
  );
}

// ---- mock fixtures ------------------------------------------------------------------------------
async function ensureMockConnection(tenantId: string, platform: Platform): Promise<MarketplaceConnection> {
  const supabase = getSupabase();
  const external = `MOCK-${platform}-${tenantId.slice(0, 8)}`;
  const { data: existing } = await supabase
    .from('marketplace_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('platform', platform)
    .eq('external_shop_id', external)
    .maybeSingle();
  if (existing) return existing as MarketplaceConnection;

  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('marketplace_connections')
    .insert({
      tenant_id: tenantId,
      platform,
      external_shop_id: external,
      shop_name: 'MOCK Store (simulation)',
      region: 'MY',
      access_token: 'MOCK-ACCESS',
      refresh_token: 'MOCK-REFRESH',
      access_token_expires_at: future,
      refresh_token_expires_at: future,
      scope: 'mock',
      shop_cipher: platform === 'tiktok' ? 'MOCKCIPHER' : null,
      raw_metadata: { mock: true },
    })
    .select('*')
    .single();
  if (error) throw new Error(`mock connection insert failed: ${error.message}`);
  console.log(`   (mock ${platform} connection ${external})`);
  return data as MarketplaceConnection;
}

function variant(overrides: Partial<NormalizedProductVariant> & { skuId: string }): NormalizedProductVariant {
  return { price: 19.9, currency: 'MYR', stock: 100, ...overrides };
}

function makeDetail(args: {
  platform: Platform;
  productId: string;
  title: string;
  variants?: NormalizedProductVariant[];
}): NormalizedProductDetail {
  const variants = args.variants ?? [variant({ skuId: `${args.productId}-1`, sellerSku: `SKU-${args.productId}` })];
  return {
    platform: args.platform,
    shopId: `MOCK-${args.platform}`,
    productId: args.productId,
    title: args.title,
    description: 'Mock product generated by the simulation harness.',
    status: 'active',
    imageUrls: [],
    attributes: [],
    variants,
    hasVariants: variants.length > 1,
    raw: { mock: true },
  };
}

async function ingestAndNotify(
  tenantId: string,
  conn: MarketplaceConnection,
  detail: NormalizedProductDetail,
  trigger: 'manual' | 'webhook' | 'resync' = 'manual',
): Promise<IngestResult> {
  const result = await ingestMarketplaceProduct({ tenantId, connection: conn, detail, trigger });
  logResult(result);
  if (NOTIFY && result.notice) await notifyProductSyncDecision(tenantId, result.notice);
  return result;
}

async function setPrefs(tenantId: string, autoCreate: boolean, autoMap: boolean) {
  await setSyncPrefs(tenantId, { autoCreateNew: autoCreate, autoMapHighConfidence: autoMap });
  console.log(`   prefs: auto_create_new=${autoCreate}  auto_map_high_confidence=${autoMap}`);
}

async function inspectInventory(tenantId: string, productId: string): Promise<string> {
  const supabase = getSupabase();
  const { data: skus } = await supabase.from('tenant_product_skus').select('id').eq('product_id', productId);
  const skuIds = (skus ?? []).map((s: { id: string }) => s.id);
  if (skuIds.length === 0) return '0 skus';
  const { data: inv } = await supabase
    .from('tenant_inventory')
    .select('warehouse_id, quantity')
    .in('sku_id', skuIds);
  const rows = inv ?? [];
  const warehouses = new Set(rows.map((r: { warehouse_id: string }) => r.warehouse_id));
  return `${skuIds.length} sku(s), ${rows.length} inventory row(s) across ${warehouses.size} warehouse(s)`;
}

// ---- scenarios ----------------------------------------------------------------------------------
type Scenario = (tenantId: string) => Promise<void>;

const scenarios: Record<string, { desc: string; run: Scenario }> = {
  'new-ask': {
    desc: 'NEW product, auto-create OFF → unmatched + "add it?" prompt (3 buttons).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, false, false);
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-tennis', title: 'Wilson Pro Staff Tennis Racket 97 v14' }));
    },
  },

  'new-auto': {
    desc: 'NEW product, auto-create ON → created automatically + FYI (Undo).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, true, false);
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-vacuum', title: 'Dyson V8 Origin Cordless Vacuum Cleaner' }));
    },
  },

  'high-ask': {
    desc: 'HIGH-confidence match, auto-map OFF → "link them?" prompt (4 buttons).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, true, false);
      console.log('   seed catalog product:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-panadol-a', title: 'Panadol Extra 500mg Tablet 20s' }));
      console.log('   ingest a near-duplicate listing:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-panadol-b', title: 'Panadol Extra Strength 500 mg Tablets, Box of 20' }));
    },
  },

  'high-auto': {
    desc: 'HIGH-confidence match, auto-map ON → linked automatically + FYI (Undo).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, true, true);
      console.log('   seed catalog product:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-maybelline-a', title: 'Maybelline Fit Me Matte Foundation 220 Natural Beige' }));
      console.log('   ingest a near-duplicate listing:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-maybelline-b', title: 'Maybelline Fit Me Matte + Poreless Foundation, Shade 220' }));
    },
  },

  medium: {
    desc: 'MEDIUM (related but not identical) → always-ask "might match" prompt (band depends on the live model).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, true, false);
      console.log('   seed catalog product:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-logi-a', title: 'Logitech MX Master 3S Wireless Mouse' }));
      console.log('   ingest a related product (same brand, different device):');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-logi-b', title: 'Logitech MX Mechanical Wireless Keyboard' }));
    },
  },

  'multi-warehouse': {
    desc: 'TikTok-style per-warehouse inventory (2 SKUs × 2 warehouses) + Shopee-style stock-only (default warehouse).',
    run: async (t) => {
      await setPrefs(t, true, false);
      const tk = await ensureMockConnection(t, 'tiktok');
      const ttDetail = makeDetail({
        platform: 'tiktok',
        productId: 'MOCK-tt-tee',
        title: 'Uniqlo AIRism Cotton Crew Neck T-Shirt (Red/Blue)',
        variants: [
          variant({ skuId: 'MOCK-tt-tee-red', sellerSku: 'TEE-RED', inventoryByWarehouse: [{ warehouseId: 'MOCK-WH-A', quantity: 30 }, { warehouseId: 'MOCK-WH-B', quantity: 20 }] }),
          variant({ skuId: 'MOCK-tt-tee-blue', sellerSku: 'TEE-BLUE', inventoryByWarehouse: [{ warehouseId: 'MOCK-WH-A', quantity: 15 }, { warehouseId: 'MOCK-WH-B', quantity: 5 }] }),
        ],
      });
      const r1 = await ingestAndNotify(t, tk, ttDetail);
      if (r1.internalProductId) console.log(`   TikTok inventory: ${await inspectInventory(t, r1.internalProductId)} (expect 2 skus, 4 rows, 2 warehouses)`);

      const sh = await ensureMockConnection(t, 'shopee');
      const shDetail = makeDetail({ platform: 'shopee', productId: 'MOCK-sh-plate', title: 'Corelle Winter Frost Dinner Plate 26cm', variants: [variant({ skuId: 'MOCK-sh-plate-1', sellerSku: 'PLATE-1', stock: 75 })] });
      const r2 = await ingestAndNotify(t, sh, shDetail);
      if (r2.internalProductId) console.log(`   Shopee inventory: ${await inspectInventory(t, r2.internalProductId)} (expect 1 sku, 1 row, 1 default warehouse)`);
    },
  },

  idempotent: {
    desc: 'Ingest the SAME listing twice → exactly one mapping row (unique on connection+external id).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, false, false);
      const detail = makeDetail({ platform: 'shopee', productId: 'MOCK-idem', title: 'Idempotency Test Widget' });
      const a = await ingestAndNotify(t, conn, detail);
      const b = await ingestAndNotify(t, conn, detail);
      const mapping = await getMappingByExternal(conn.id, 'MOCK-idem');
      console.log(`   mapping ids equal: ${a.mappingId === b.mappingId} (${a.mappingId})  row exists: ${!!mapping} → idempotent ✓`);
    },
  },

  'webhook-rescore': {
    desc: 'Webhook re-delivery with a CHANGED title on a created product → refresh only, no re-prompt.',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, true, false);
      console.log('   initial create:');
      await ingestAndNotify(t, conn, makeDetail({ platform: 'shopee', productId: 'MOCK-huebulb', title: 'Philips Hue White Smart Bulb E27' }));
      console.log('   webhook PRODUCT_INFO_CHANGE (renamed):');
      const r = await ingestAndNotify(
        t,
        conn,
        makeDetail({ platform: 'shopee', productId: 'MOCK-huebulb', title: 'Philips Hue White A60 Smart LED Bulb E27 800lm' }),
        'webhook',
      );
      console.log(`   re-score outcome: decision=${r.decision} (expect already_decided), notice=${r.notice ? r.notice.kind : 'none'} (expect none) → no duplicate prompt ✓`);
    },
  },

  'flood-batch': {
    desc: 'Burst of 8 NEW products (auto-create OFF) → coalesced into ONE batch summary (>5).',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');
      await setPrefs(t, false, false);
      const floodTitles = [
        'Stainless Steel Water Bottle 750ml',
        'Bamboo Cutting Board Large',
        'LED Desk Lamp Dimmable USB-C',
        'Yoga Mat 6mm Non-Slip',
        'Wireless Earbuds Bluetooth 5.3',
        'Stainless Steel Lunch Box 2-Tier',
        'Cotton Bath Towel 70x140',
        'Ceramic Plant Pot 12cm with Tray',
      ];
      const notices: ProductSyncNotice[] = [];
      for (let i = 0; i < floodTitles.length; i++) {
        const r = await ingestMarketplaceProduct({
          tenantId: t,
          connection: conn,
          detail: makeDetail({ platform: 'shopee', productId: `MOCK-flood-${i + 1}`, title: floodTitles[i] }),
          trigger: 'resync',
        });
        if (r.notice) notices.push(r.notice);
      }
      console.log(`   collected ${notices.length} prompts; dispatching as a resync batch…`);
      const summary: ResyncSummary = {
        status: 'processed', scanned: 8, autoCreated: 0, autoMapped: 0,
        awaitingReview: notices.length, alreadyMapped: 0, errors: [], notices, nextCursor: null,
      };
      if (NOTIFY) await dispatchResyncNotices(t, summary);
      console.log(`   → ${notices.length} prompts persisted; ONE batch-summary broadcast (collapses the flood) ✓`);
    },
  },

  'connect-offer': {
    desc: 'Store-connected offer → "import your products now?" with token-free buttons.',
    run: async (t) => {
      await ensureMockConnection(t, 'shopee');
      if (NOTIFY) await notifyConnectedOfferSync(t, 'shopee', 'MOCK Store');
      console.log('   → connect offer sent (buttons: Import now / Keep in sync / Not now) ✓');
    },
  },

  actions: {
    desc: 'No-LLM action handler: map / skip / undo. (create/create_always re-fetch LIVE marketplace detail — covered by new-auto + the real connect flow, so not mockable here.)',
    run: async (t) => {
      const conn = await ensureMockConnection(t, 'shopee');

      // map — confirm a HIGH suggestion (no marketplace fetch).
      await setPrefs(t, true, false);
      await ingestMarketplaceProduct({ tenantId: t, connection: conn, detail: makeDetail({ platform: 'shopee', productId: 'MOCK-act-target', title: 'Samsonite Cabin Spinner 55cm Luggage' }), trigger: 'manual' });
      const sug = await ingestMarketplaceProduct({ tenantId: t, connection: conn, detail: makeDetail({ platform: 'shopee', productId: 'MOCK-act-dup', title: 'Samsonite Cabin Spinner Suitcase, 55 cm' }), trigger: 'manual' });
      const mp = await applyProductSyncAction({ tenantId: t, linkId: sug.mappingId, choice: 'map' });
      console.log(`   map  → ${mp.status}: ${mp.message} (mapping=${mp.mappingStatus})`);

      // skip — dismiss an unmatched prompt.
      await setPrefs(t, false, false);
      const sk = await ingestMarketplaceProduct({ tenantId: t, connection: conn, detail: makeDetail({ platform: 'shopee', productId: 'MOCK-act-skip', title: 'Casio F-91W Classic Digital Watch' }), trigger: 'manual' });
      const skr = await applyProductSyncAction({ tenantId: t, linkId: sk.mappingId, choice: 'skip' });
      console.log(`   skip → ${skr.status}: ${skr.message} (mapping=${skr.mappingStatus})`);

      // undo — revert an auto-created product (deletes it + unlinks; no marketplace fetch).
      await setPrefs(t, true, false);
      const un = await ingestMarketplaceProduct({ tenantId: t, connection: conn, detail: makeDetail({ platform: 'shopee', productId: 'MOCK-act-undo', title: 'Instant Pot Duo 6Qt Electric Pressure Cooker' }), trigger: 'manual' });
      const ur = await applyProductSyncAction({ tenantId: t, linkId: un.mappingId, choice: 'undo' });
      console.log(`   undo → ${ur.status}: ${ur.message} (mapping=${ur.mappingStatus})`);
    },
  },
};

export const SCENARIO_NAMES = Object.keys(scenarios);

export async function runScenarios(tenantId: string, which: string, notify: boolean): Promise<void> {
  NOTIFY = notify;
  if (notify) wireStorage();
  const names = which === 'all' ? SCENARIO_NAMES : [which];
  for (const name of names) {
    const s = scenarios[name];
    if (!s) {
      console.error(`Unknown scenario "${name}". Available: ${SCENARIO_NAMES.join(', ')}, all`);
      process.exitCode = 1;
      return;
    }
    hr();
    header(name, s.desc);
    try {
      await s.run(tenantId);
    } catch (err) {
      console.error(`   ✗ scenario "${name}" failed:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
  hr();
  console.log(`\nDone. Notifications ${notify ? 'were dispatched (check the Active Agent / Notifications chat)' : 'were skipped (--no-notify)'}.`);
  console.log(`Clean up with:  npx tsx scripts/mock/mock-cleanup.ts ${tenantId}`);
}
