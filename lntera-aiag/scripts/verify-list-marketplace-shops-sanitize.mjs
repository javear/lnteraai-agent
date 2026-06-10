/**
 * Sanity-check: sanitized shop rows must not expose credential field names.
 * Run: node scripts/verify-list-marketplace-shops-sanitize.mjs
 */

const FORBIDDEN_KEYS = new Set([
  'access_token',
  'refresh_token',
  'shop_cipher',
  'cipher',
  'open_id',
  'raw_metadata',
  'external_shop_id',
]);

const sample = {
  success: true,
  shops: [
    {
      platform: 'shopee',
      shopId: '12345',
      name: 'Demo Shop',
      region: 'ID',
      status: 'ready',
    },
    {
      platform: 'tiktok',
      shopId: '7123456789',
      name: 'TT Shop',
      region: 'ID',
      shopCode: 'IDABC',
      status: 'ready',
    },
  ],
  summary: { total: 2, shopee: 1, tiktok: 1, needsReconnect: 0 },
};

function collectKeys(obj, prefix = '') {
  const keys = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      keys.push(prefix ? `${prefix}.${k}` : k);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        keys.push(...collectKeys(v, prefix ? `${prefix}.${k}` : k));
      }
    }
  }
  return keys;
}

const keys = collectKeys(sample);
const leaked = keys.filter((k) => {
  const leaf = k.split('.').pop() ?? k;
  return FORBIDDEN_KEYS.has(leaf);
});

if (leaked.length > 0) {
  console.error('FAIL: forbidden keys in sample shape:', leaked);
  process.exit(1);
}

const json = JSON.stringify(sample);
if (/\bROW_[A-Za-z0-9]+\b/.test(json)) {
  console.error('FAIL: sample contains ROW_ cipher pattern');
  process.exit(1);
}

console.log('OK: list-marketplace-shops sanitized output shape has no credential keys');
