#!/usr/bin/env node
/**
 * Send a sample marketplace webhook to trigger general-agent active mode for a tenant.
 *
 * Default tenant: f7cb382f-d1d8-4c36-b3fc-382f0436a228
 *
 * Modes:
 *   --http   (default) POST signed payload to a running Mastra server (npm run dev).
 *   --direct Start Discord in-process and call notifyTenantOfMarketplaceEvent (no HTTP).
 *
 * Usage:
 *   node scripts/send-sample-webhook.mjs
 *   node scripts/send-sample-webhook.mjs --platform tiktok --category fulfillment
 *   node scripts/send-sample-webhook.mjs --direct
 *   node scripts/send-sample-webhook.mjs --dry-run
 *   node scripts/send-sample-webhook.mjs --tenant <uuid> --platform shopee
 *
 * Env (from lntera-aiag/.env):
 *   SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) — resolve shop_id for HTTP
 *   SHOPEE_PUSH_PARTNER_KEY — Shopee signature (--http + shopee)
 *   TIKTOK_APP_SECRET — TikTok signature (--http + tiktok)
 *   OPENAPI_BASE_URL / WEBHOOK_BASE_URL — default http://localhost:4111
 *   SAMPLE_WEBHOOK_SHOP_ID — override shop id when tenant has no marketplace_connections row
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const DEFAULT_TENANT = 'bc25b4f0-769b-4ac6-88c5-44287741cc75';

function applyEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\r$/, '').trim();
    if (!val) continue;
    if (!process.env[key]?.trim()) {
      process.env[key] = val;
    }
  }
}

function loadDotEnv() {
  applyEnvFile(resolve(process.cwd(), '.env'));
  applyEnvFile(resolve(PKG_ROOT, '.env'));
}

loadDotEnv();

function parseCli(argv) {
  const out = {
    tenantId: DEFAULT_TENANT,
    platform: 'shopee',
    category: 'orders',
    mode: 'http',
    dryRun: false,
    baseUrl: (process.env.WEBHOOK_BASE_URL ?? process.env.OPENAPI_BASE_URL ?? 'http://localhost:4111').replace(
      /\/$/,
      '',
    ),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant' && argv[i + 1]) out.tenantId = argv[++i];
    else if (a === '--platform' && argv[i + 1]) out.platform = argv[++i];
    else if (a === '--category' && argv[i + 1]) out.category = argv[++i];
    else if (a === '--base-url' && argv[i + 1]) out.baseUrl = argv[++i].replace(/\/$/, '');
    else if (a === '--http') out.mode = 'http';
    else if (a === '--direct') out.mode = 'direct';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Send a sample marketplace webhook (active mode → Discord).

Default tenant: ${DEFAULT_TENANT}

Usage:
  node scripts/send-sample-webhook.mjs [options]

Options:
  --tenant <uuid>       Tenant master id (default: ${DEFAULT_TENANT})
  --platform shopee|tiktok   (default: shopee)
  --category orders|fulfillment|returns   (default: orders)
  --http                POST to running Mastra /webhooks/* (default)
  --direct              In-process: start Discord + notifyTenantOfMarketplaceEvent
  --base-url <url>      Mastra base URL (default: http://localhost:4111)
  --dry-run             Print payload + curl only, do not send

Examples:
  node scripts/send-sample-webhook.mjs
  node scripts/send-sample-webhook.mjs --platform tiktok --category fulfillment
  node scripts/send-sample-webhook.mjs --direct
  npm run send-sample-webhook
`);
}

function buildShopeePayload(category, shopId) {
  const orderSn = `SAMPLE-${Date.now()}`;
  const codeByCategory = { orders: 3, fulfillment: 4, returns: 10 };
  const statusByCategory = {
    orders: 'READY_TO_SHIP',
    fulfillment: 'SHIPPED',
    returns: 'RETURN_REQUESTED',
  };
  return {
    shop_id: Number(shopId) || shopId,
    code: codeByCategory[category] ?? 3,
    timestamp: Math.floor(Date.now() / 1000),
    data: {
      ordersn: orderSn,
      order_status: statusByCategory[category] ?? 'READY_TO_SHIP',
      update_time: Math.floor(Date.now() / 1000),
    },
  };
}

function buildTiktokPayload(category, shopId) {
  const orderSn = `SAMPLE-${Date.now()}`;
  const typeByCategory = { orders: 1, fulfillment: 4, returns: 2 };
  const statusByCategory = {
    orders: 'AWAITING_SHIPMENT',
    fulfillment: 'IN_TRANSIT',
    returns: 'RETURN_REQUESTED',
  };
  return {
    type: typeByCategory[category] ?? 1,
    shop_id: shopId,
    timestamp: Date.now(),
    data: {
      shop_id: shopId,
      shop_cipher: process.env.SAMPLE_WEBHOOK_SHOP_CIPHER?.trim() || undefined,
      order_id: orderSn,
      order_status: statusByCategory[category] ?? 'AWAITING_SHIPMENT',
    },
  };
}

async function resolveShopIdsForTenant(tenantId, platform) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.warn('[sample-webhook] Supabase not configured — using SAMPLE_WEBHOOK_SHOP_ID or placeholder shop id');
    return { shopeeShopId: process.env.SAMPLE_WEBHOOK_SHOP_ID?.trim() || '0', tiktokShopId: process.env.SAMPLE_WEBHOOK_SHOP_ID?.trim() || '0', tiktokCipher: process.env.SAMPLE_WEBHOOK_SHOP_CIPHER?.trim() || null };
  }

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase
    .from('marketplace_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('platform', platform);

  if (error) throw new Error(`Supabase: ${error.message}`);
  const rows = data ?? [];
  let shopeeShopId = process.env.SAMPLE_WEBHOOK_SHOP_ID?.trim() || null;
  let tiktokShopId = process.env.SAMPLE_WEBHOOK_SHOP_ID?.trim() || null;
  let tiktokCipher = process.env.SAMPLE_WEBHOOK_SHOP_CIPHER?.trim() || null;

  for (const row of rows) {
    if (row.platform === 'shopee' && !shopeeShopId) shopeeShopId = String(row.external_shop_id);
    if (row.platform === 'tiktok') {
      if (!tiktokShopId) tiktokShopId = String(row.external_shop_id);
      if (!tiktokCipher && row.shop_cipher) tiktokCipher = String(row.shop_cipher);
      const meta = row.raw_metadata;
      if (meta && typeof meta === 'object' && Array.isArray(meta.shops) && meta.shops[0]?.id) {
        tiktokShopId = String(meta.shops[0].id);
        if (!tiktokCipher && meta.shops[0].cipher) tiktokCipher = String(meta.shops[0].cipher);
      }
    }
  }

  return {
    shopeeShopId: shopeeShopId ?? '0',
    tiktokShopId: tiktokShopId ?? '0',
    tiktokCipher,
  };
}

function signShopee(url, rawBody, pushPartnerKey) {
  return createHmac('sha256', pushPartnerKey).update(`${url}|${rawBody}`).digest('hex');
}

function signTiktok(rawBody, appSecret) {
  return createHmac('sha256', appSecret).update(`${appSecret}${rawBody}`).digest('hex');
}

async function postHttp({ baseUrl, platform, payload, dryRun }) {
  const path = platform === 'shopee' ? '/webhooks/shopee' : '/webhooks/tiktok';
  const url = `${baseUrl}${path}`;
  const rawBody = JSON.stringify(payload);

  const headers = { 'Content-Type': 'application/json' };

  if (platform === 'shopee') {
    const pushKey = process.env.SHOPEE_PUSH_PARTNER_KEY?.trim();
    if (!pushKey && !dryRun) {
      console.error('Missing SHOPEE_PUSH_PARTNER_KEY in .env (required for --http --platform shopee).');
      console.error('  Or use --direct to bypass HTTP signature verification.');
      process.exit(1);
    }
    if (pushKey) {
      const sig = signShopee(url, rawBody, pushKey);
      headers.authorization = `SHA256=${sig}`;
    }
  } else {
    const appSecret = process.env.TIKTOK_APP_SECRET?.trim();
    if (!appSecret && !dryRun) {
      console.error('Missing TIKTOK_APP_SECRET in .env (required for --http --platform tiktok).');
      process.exit(1);
    }
    if (appSecret) {
      headers['x-tts-signature'] = signTiktok(rawBody, appSecret);
    }
  }

  if (dryRun) {
    console.log('\n--- dry-run ---');
    console.log('POST', url);
    console.log('Headers:', JSON.stringify(headers, null, 2));
    console.log('Body:', JSON.stringify(payload, null, 2));
    console.log('\nCurl:');
    const hdr = Object.entries(headers)
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(' ');
    console.log(`curl -sS -X POST ${hdr} -d '${rawBody.replace(/'/g, "'\\''")}' '${url}'`);
    return;
  }

  const res = await fetch(url, { method: 'POST', headers, body: rawBody });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(`HTTP ${res.status}`);
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (!res.ok) process.exit(1);
}

async function runDirect({ tenantId, platform, category }) {
  const shops = await resolveShopIdsForTenant(tenantId, platform);
  const env = { ...process.env };
  env.SAMPLE_WEBHOOK_SHOP_ID = platform === 'shopee' ? shops.shopeeShopId : shops.tiktokShopId;
  if (shops.tiktokCipher) env.SAMPLE_WEBHOOK_SHOP_CIPHER = shops.tiktokCipher;

  const tsx = resolve(PKG_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const script = resolve(PKG_ROOT, 'scripts/send-sample-webhook-direct.ts');
  const args = [
    tsx,
    script,
    '--tenant',
    tenantId,
    '--platform',
    platform,
    '--category',
    category,
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env,
      cwd: PKG_ROOT,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`direct runner exited ${code}`));
    });
  });
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  if (!['shopee', 'tiktok'].includes(cli.platform)) {
    console.error('--platform must be shopee or tiktok');
    process.exit(1);
  }
  if (!['orders', 'fulfillment', 'returns'].includes(cli.category)) {
    console.error('--category must be orders, fulfillment, or returns');
    process.exit(1);
  }

  console.info(
    `[sample-webhook] tenant=${cli.tenantId} platform=${cli.platform} category=${cli.category} mode=${cli.mode}`,
  );

  if (cli.mode === 'direct') {
    if (cli.dryRun) {
      console.error('--dry-run is not supported with --direct (would still start Discord).');
      process.exit(1);
    }
    await runDirect(cli);
    return;
  }

  const shops = await resolveShopIdsForTenant(cli.tenantId, cli.platform);
  const shopId = cli.platform === 'shopee' ? shops.shopeeShopId : shops.tiktokShopId;
  if (shopId === '0') {
    console.warn(
      `[sample-webhook] No ${cli.platform} connection for tenant ${cli.tenantId}. ` +
        'HTTP handler may return tenant_not_found. Set SAMPLE_WEBHOOK_SHOP_ID to a connected shop id.',
    );
  }

  const payload =
    cli.platform === 'shopee'
      ? buildShopeePayload(cli.category, shopId)
      : buildTiktokPayload(cli.category, shopId);

  if (cli.platform === 'tiktok' && shops.tiktokCipher && payload.data) {
    payload.data.shop_cipher = shops.tiktokCipher;
  }

  await postHttp({
    baseUrl: cli.baseUrl,
    platform: cli.platform,
    payload,
    dryRun: cli.dryRun,
  });

  if (!cli.dryRun) {
    console.info(
      '\nNote: HTTP returns ok immediately; agent + Discord run in the background on the server.',
    );
    console.info('Watch the Mastra terminal for [webhook] / [active] / [discord] logs.');
  }
}

main().catch((err) => {
  console.error('[sample-webhook] failed', err);
  process.exit(1);
});
