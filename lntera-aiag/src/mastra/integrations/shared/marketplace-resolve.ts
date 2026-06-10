import { getSupabase } from './supabase';
import type { MarketplaceConnection } from './types';

const TABLE = 'marketplace_connections';

/**
 * Cross-tenant connection lookup for inbound webhooks.
 *
 * `getConnection(platform, externalShopId)` in `./supabase` already does the simple
 * `(platform, external_shop_id)` match. The helpers in this module additionally cover the
 * TikTok case where the webhook surfaces a `shop_id` that does NOT equal what we store as
 * `external_shop_id` (we usually store `open_id` there), and the shop is reachable only via
 * `shop_cipher` or `raw_metadata.shops[].id`.
 *
 * These functions intentionally do NOT take a `tenant_id` — webhook traffic is unauthenticated
 * and the whole point of these helpers is to figure out which tenant a payload belongs to.
 */

/**
 * Shopee push payloads always carry `shop_id` (numeric). Our OAuth flow stores
 * `external_shop_id = String(shop_id)`, so a direct `(platform, external_shop_id)` match
 * is sufficient. Returns `null` if no row exists for that shop.
 */
export async function findShopeeConnectionByShopId(
  shopId: string,
): Promise<MarketplaceConnection | null> {
  const ext = shopId.trim();
  if (!ext) return null;

  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('platform', 'shopee')
    .eq('external_shop_id', ext)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to find Shopee connection (shop_id=${ext}): ${error.message}`);
  }
  return (data as MarketplaceConnection | null) ?? null;
}

/**
 * Resolve a TikTok connection for a webhook `shop_id` / optional `shop_cipher`.
 *
 * Search order (first non-null match wins):
 *  1. `shop_cipher` column equals the hinted cipher (when payload included it).
 *  2. `shop_cipher` column equals the `shop_id` (some apps stored the cipher in `shop_cipher`).
 *  3. `external_shop_id` equals the `shop_id` (some apps stored the shop id directly).
 *  4. Scan rows where `raw_metadata->'shops'` contains an entry with matching `id` or `cipher`.
 *
 * The scan in step 4 is fine for the current scale (few connections per platform); revisit
 * with a generated column or expression index if the table grows.
 */
export async function findTiktokConnectionByShopId(args: {
  shopId: string | null;
  shopCipher?: string | null;
}): Promise<MarketplaceConnection | null> {
  const supabase = getSupabase();
  const cipher = args.shopCipher?.trim() || null;
  const shopId = args.shopId?.trim() || null;

  if (cipher) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('platform', 'tiktok')
      .eq('shop_cipher', cipher)
      .maybeSingle();
    if (error && !isMaybeSingleAmbiguityError(error)) {
      throw new Error(`Failed to find TikTok connection by shop_cipher: ${error.message}`);
    }
    if (data) return data as MarketplaceConnection;
  }

  if (shopId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('platform', 'tiktok')
      .eq('shop_cipher', shopId)
      .maybeSingle();
    if (error && !isMaybeSingleAmbiguityError(error)) {
      throw new Error(`Failed to find TikTok connection by shop_cipher fallback: ${error.message}`);
    }
    if (data) return data as MarketplaceConnection;

    const direct = await supabase
      .from(TABLE)
      .select('*')
      .eq('platform', 'tiktok')
      .eq('external_shop_id', shopId)
      .maybeSingle();
    if (direct.error && !isMaybeSingleAmbiguityError(direct.error)) {
      throw new Error(`Failed to find TikTok connection by external_shop_id: ${direct.error.message}`);
    }
    if (direct.data) return direct.data as MarketplaceConnection;
  }

  if (cipher || shopId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('platform', 'tiktok');
    if (error) {
      throw new Error(`Failed to scan TikTok connections: ${error.message}`);
    }
    const rows = (data as MarketplaceConnection[] | null) ?? [];
    for (const row of rows) {
      if (rowMatchesTiktokIdentity(row, { shopId, cipher })) return row;
    }
  }

  return null;
}

function rowMatchesTiktokIdentity(
  row: MarketplaceConnection,
  ident: { shopId: string | null; cipher: string | null },
): boolean {
  if (ident.cipher && row.shop_cipher && row.shop_cipher.trim() === ident.cipher) return true;
  const meta = (row.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];
  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = r.id != null ? String(r.id).trim() : '';
    const code = typeof r.code === 'string' ? r.code.trim() : '';
    const c = typeof r.cipher === 'string' ? r.cipher.trim() : '';
    if (ident.cipher && c && c === ident.cipher) return true;
    if (ident.shopId && (id === ident.shopId || code === ident.shopId || c === ident.shopId)) return true;
  }
  return false;
}

/**
 * `maybeSingle` returns an error when it finds zero rows in some PostgREST versions
 * (`PGRST116` "Results contain 0 rows" only) and a different error when it finds
 * more than one. Treat zero/single-row "errors" as a soft miss.
 */
function isMaybeSingleAmbiguityError(error: { code?: string; details?: string; message?: string }): boolean {
  if (!error) return false;
  if (error.code === 'PGRST116') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('0 rows') || msg.includes('contains 0 rows');
}
