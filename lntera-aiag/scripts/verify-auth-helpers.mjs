#!/usr/bin/env node
/**
 * Offline sanity-check for the OAuth helpers. No Supabase / network needed.
 *   node scripts/verify-auth-helpers.mjs
 */
import { createHmac } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Use tsx-style on-the-fly TS loading via the Node's experimental TypeScript stripping (Node 22+).
// We import the .ts files by URL after setting envs.

process.env.OAUTH_STATE_SECRET ||= 'unit-test-secret-change-me';
process.env.SHOPEE_PARTNER_ID ||= '1000000';
process.env.SHOPEE_PARTNER_KEY ||= 'shoppe-secret';
process.env.SHOPEE_REDIRECT_URL ||= 'http://localhost:4111/oauth/shopee/callback';
process.env.SHOPEE_REGION ||= 'test';
process.env.TIKTOK_APP_KEY ||= 'tiktok-app-key';
process.env.TIKTOK_APP_SECRET ||= 'tiktok-app-secret';
process.env.TIKTOK_REDIRECT_URL ||= 'http://localhost:4111/oauth/tiktok/callback';

const base = pathToFileURL(process.cwd() + '/src/mastra/integrations/').href;

const { createState, verifyState } = await import(base + 'shared/oauth-state.ts');
const { signPublic, signShop } = await import(base + 'shopee/sign.ts');
const { buildShopeeAuthUrl } = await import(base + 'shopee/auth.ts');
const { signTiktok } = await import(base + 'tiktok/sign.ts');
const { buildTiktokAuthUrl } = await import(base + 'tiktok/auth.ts');

let failed = 0;
function check(name, ok, info) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failed++;
  console.log(`[${tag}] ${name}${info ? ' - ' + info : ''}`);
}

// 1. State roundtrip
const state = createState({ platform: 'shopee', tenantId: 'tenant-1' });
const verified = verifyState(state);
check('state roundtrip preserves platform', verified.platform === 'shopee');
check('state roundtrip preserves tenantId', verified.tenantId === 'tenant-1');

let tampered = state.slice(0, -2) + (state.endsWith('a') ? 'b' : 'a') + state.slice(-1);
let tamperOk = false;
try { verifyState(tampered); } catch { tamperOk = true; }
check('tampered state is rejected', tamperOk);

// 2. Shopee sign vs reference HMAC
const partnerId = 1000000;
const partnerKey = 'shoppe-secret';
const path = '/api/v2/shop/auth_partner';
const ts = 1700000000;
const expectedPublic = createHmac('sha256', partnerKey).update(`${partnerId}${path}${ts}`).digest('hex');
const gotPublic = signPublic({ partnerId, partnerKey, path, timestamp: ts });
check('shopee public sign matches reference HMAC', gotPublic === expectedPublic, gotPublic);

const shopId = 555;
const accessToken = 'ACCESS123';
const expectedShop = createHmac('sha256', partnerKey)
  .update(`${partnerId}${path}${ts}${accessToken}${shopId}`)
  .digest('hex');
const gotShop = signShop({ partnerId, partnerKey, path, timestamp: ts, accessToken, shopId });
check('shopee shop sign matches reference HMAC', gotShop === expectedShop, gotShop);

// 3. Shopee auth URL has all required params
const shopeeUrl = new URL(buildShopeeAuthUrl(state));
check('shopee auth URL host is test stable', shopeeUrl.host === 'partner.test-stable.shopeemobile.com', shopeeUrl.host);
for (const p of ['partner_id', 'timestamp', 'sign', 'redirect', 'state']) {
  check(`shopee auth URL has ${p}`, shopeeUrl.searchParams.has(p));
}

// 4. TikTok sign vs known basestring
const appSecret = 'tiktok-app-secret';
const tikQuery = { app_key: 'k', timestamp: 123, shop_id: 'abc', access_token: 'should-be-excluded' };
const tikPath = '/product/202309/products/search';
const body = JSON.stringify({ q: 'shoes' });
// Manual reference: drop sign+access_token, sort -> [app_key=k][shop_id=abc][timestamp=123]
const refBase = `${tikPath}app_keykshop_idabctimestamp123${body}`;
const refSig = createHmac('sha256', appSecret).update(appSecret + refBase + appSecret).digest('hex');
const gotTik = signTiktok({
  appSecret,
  path: tikPath,
  query: tikQuery,
  body,
  contentType: 'application/json',
});
check('tiktok sign matches manual reference', gotTik === refSig, gotTik);

// 5. TikTok auth URL
const tikUrl = new URL(buildTiktokAuthUrl(state));
check('tiktok auth URL host', tikUrl.host === 'auth.tiktok-shops.com', tikUrl.host);
for (const p of ['app_key', 'state']) {
  check(`tiktok auth URL has ${p}`, tikUrl.searchParams.has(p));
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed.');
