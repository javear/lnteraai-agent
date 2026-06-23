/**
 * TEST-ONLY remap of an incoming webhook `shop_id` to a real connected shop.
 *
 * Marketplace "test push" console tools (e.g. Shopee's "Get Test Push") send a FIXED sample shop_id
 * that you cannot change, so the push can't resolve to any of your connected shops (the handler logs
 * `tenant_not_found`). Set a remap so those test pushes route to a shop you have actually connected:
 *
 *   SHOPEE_TEST_SHOP_REMAP="564186623:227476195"
 *   TIKTOK_TEST_SHOP_REMAP="<testShopId>:<realShopId>"
 *
 * Comma-separate multiple pairs: "from1:to1,from2:to2". A pair may be separated by ":" or "=" (shop
 * ids are numeric, so there's no ambiguity). It is a no-op (returns the original id) unless
 * the matching env is set and contains the source id. Leave it UNSET in a normal production deployment —
 * it deliberately misroutes the source shop id to the target tenant, which is only what you want for testing.
 */
function parsePairs(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    // Accept either "from:to" or "from=to" (shop ids are numeric → the separator is unambiguous).
    const m = pair.match(/^\s*([^:=\s]+)\s*[:=]\s*([^:=\s]+)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

export function remapTestShopId(platform: 'shopee' | 'tiktok', shopId: string): string {
  const raw = platform === 'shopee' ? process.env.SHOPEE_TEST_SHOP_REMAP : process.env.TIKTOK_TEST_SHOP_REMAP;
  return parsePairs(raw).get(shopId) ?? shopId;
}
