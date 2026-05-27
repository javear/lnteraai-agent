/**
 * Debug Shopee get_shop_info. Loads .env from lntera-aiag root.
 * Usage: npx tsx scripts/debug-shopee-shop-info.mjs [shopId]
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  const raw = readFileSync(resolve(root, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

loadEnv();

const shopId = process.argv[2] || '227476195';

const { getShopeeClient } = await import('../src/mastra/integrations/shopee/client.ts');
const { getShopeeShopInfo } = await import('../src/mastra/integrations/shopee/shop-info.ts');

try {
  const client = await getShopeeClient(shopId);
  const raw = await client.get('/api/v2/shop/get_shop_info');
  console.log('RAW:', JSON.stringify(raw, null, 2));
  const info = await getShopeeShopInfo(client);
  console.log('PARSED:', info);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
