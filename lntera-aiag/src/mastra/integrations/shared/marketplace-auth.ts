import { listConnectionsByTenant } from './supabase';
import type { MarketplaceConnection, Platform, Uuid } from './types';
import { getShopeeClient, type ShopeeClient } from '../shopee/client';
import { getTiktokClient, type TiktokClient } from '../tiktok/client';

interface RequestContextLike {
  get(key: string): unknown;
}

interface ContextWithRequestContext {
  requestContext?: RequestContextLike;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reserved RequestContext key for the active tenant.
 * Tools and agents must set this from upstream auth/middleware.
 */
export const TENANT_MASTER_ID_KEY = 'tenant_master_id';

/**
 * Read and validate `tenant_master_id` from a tool's RequestContext.
 * Throws a descriptive error when missing or malformed so the agent
 * surfaces the failure to the caller instead of silently using `undefined`.
 */
export function requireTenantContext(
  context: ContextWithRequestContext | undefined,
): Uuid {
  const rc = context?.requestContext;
  if (!rc) {
    throw new Error(
      'Missing requestContext. The tool requires a `tenant_master_id` to identify the tenant.',
    );
  }
  const raw = rc.get(TENANT_MASTER_ID_KEY);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Missing "${TENANT_MASTER_ID_KEY}" in requestContext. Set it before invoking this tool.`,
    );
  }
  const value = raw.trim();
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid "${TENANT_MASTER_ID_KEY}" in requestContext: not a UUID (got "${value}").`);
  }
  return value;
}

export interface TenantConnections {
  shopee?: MarketplaceConnection;
  tiktok?: MarketplaceConnection;
}

/**
 * Fetch a tenant's marketplace connections, keyed by platform.
 * If a tenant has multiple shops on the same platform, the first row
 * (oldest by created_at) wins; richer multi-shop selection can layer on top later.
 */
export async function getTenantConnections(
  tenantId: Uuid,
  platforms?: Platform[],
): Promise<TenantConnections> {
  const rows = await listConnectionsByTenant(tenantId, platforms);
  const result: TenantConnections = {};
  for (const row of rows) {
    if (row.platform === 'shopee' && !result.shopee) result.shopee = row;
    if (row.platform === 'tiktok' && !result.tiktok) result.tiktok = row;
  }
  return result;
}

/**
 * Resolve a Shopee client for the tenant. Returns `null` when no Shopee
 * connection exists. Token refresh is handled inside `getShopeeClient`.
 *
 * If the tenant has multiple Shopee shops, only the oldest connection is used.
 * Tools that must see every shop should call `listConnectionsByTenant` and
 * loop each `external_shop_id` (see search-orders / get-order-details).
 */
export async function withShopee<T>(
  tenantId: Uuid,
  fn: (client: ShopeeClient, connection: MarketplaceConnection) => Promise<T>,
): Promise<T | null> {
  const conns = await getTenantConnections(tenantId, ['shopee']);
  if (!conns.shopee) return null;
  const client = await getShopeeClient(conns.shopee.external_shop_id);
  return fn(client, conns.shopee);
}

/**
 * Resolve a TikTok Shop client for the tenant. Returns `null` when no
 * TikTok connection exists. Token refresh is handled inside `getTiktokClient`.
 *
 * If the tenant has multiple TikTok connections, only the oldest is used.
 * Tools that must see every shop should call `listConnectionsByTenant` and
 * loop each `external_shop_id`.
 */
export async function withTiktok<T>(
  tenantId: Uuid,
  fn: (client: TiktokClient, connection: MarketplaceConnection) => Promise<T>,
): Promise<T | null> {
  const conns = await getTenantConnections(tenantId, ['tiktok']);
  if (!conns.tiktok) return null;
  const client = await getTiktokClient(conns.tiktok.external_shop_id);
  return fn(client, conns.tiktok);
}

/**
 * `marketplace_connections.external_shop_id` may be either TikTok seller `open_id` or a `shop_cipher`
 * (some deployments store the cipher as the row key). Only strings passing this check should be sent
 * as query `shop_cipher`; sending `open_id` causes 106011 Invalid shop_cipher.
 */
/** TikTok Shop seller region (ISO 3166-1 alpha-2) → listing currency for draft/create payloads. */
const TIKTOK_REGION_CURRENCY: Record<string, string> = {
  ID: 'IDR',
  VN: 'VND',
  TH: 'THB',
  MY: 'MYR',
  SG: 'SGD',
  PH: 'PHP',
  US: 'USD',
  GB: 'GBP',
  MX: 'MXN',
  BR: 'BRL',
  JP: 'JPY',
  KR: 'KRW',
  CN: 'CNY',
  HK: 'HKD',
  TW: 'TWD',
  AU: 'AUD',
  NZ: 'NZD',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  IE: 'EUR',
};

/**
 * Best-effort shop listing currency from OAuth `raw_metadata.shops[].region`.
 * Used when creating drafts (no product SKU yet). Existing products should use
 * `variants[].currency` from get-product-details instead.
 */
export function resolveTiktokShopCurrency(
  connection: MarketplaceConnection,
  shopIdHint?: string | null,
): string | null {
  const meta = (connection.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];
  const h = shopIdHint?.trim() || null;

  const currencyForRegion = (region: string | undefined): string | null => {
    if (!region) return null;
    return TIKTOK_REGION_CURRENCY[region.trim().toUpperCase()] ?? null;
  };

  if (h) {
    for (const item of shops) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const cipher = typeof row.cipher === 'string' ? row.cipher.trim() : '';
      const id = row.id != null ? String(row.id).trim() : '';
      const code = typeof row.code === 'string' ? row.code.trim() : '';
      if (h === cipher || (id && h === id) || (code && h === code)) {
        return currencyForRegion(typeof row.region === 'string' ? row.region : undefined);
      }
    }
  }

  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const region = (item as Record<string, unknown>).region;
    const c = currencyForRegion(typeof region === 'string' ? region : undefined);
    if (c) return c;
  }

  const connRegion =
    typeof connection.region === 'string' ? connection.region : undefined;
  return currencyForRegion(connRegion);
}

export function tiktokStoredIdLooksLikeShopCipher(value: string): boolean {
  const ext = value.trim();
  return ext.length > 16 && !/^\d+$/.test(ext) && (/[A-Za-z]/.test(ext) || /[+/=]/.test(ext));
}

export function isTiktokInvalidShopCipherError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bcode=106011\b/.test(msg) || /Invalid shop_cipher/i.test(msg);
}

/**
 * Resolve TikTok `shop_cipher` for API calls.
 *
 * Multi-shop sellers often have one OAuth row (`external_shop_id` = open_id) with
 * `raw_metadata.shops` listing each shop's `cipher` and `id`. Passing **hint**
 * (usually search/get-detail `shopId`, which may be cipher or shop id) picks the
 * right cipher; otherwise we fall back to the column / first authorized shop.
 */
export function resolveTiktokShopCipher(connection: MarketplaceConnection, hint?: string | null): string | null {
  const h = hint?.trim() || null;
  const meta = (connection.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];

  if (h) {
    const ext = typeof connection.external_shop_id === 'string' ? connection.external_shop_id.trim() : '';
    for (const item of shops) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const cipher = typeof row.cipher === 'string' ? row.cipher.trim() : '';
      if (!cipher) continue;
      const id = row.id != null ? String(row.id).trim() : '';
      const code = typeof row.code === 'string' ? row.code.trim() : '';
      if (h === cipher || (id && h === id) || (code && h === code)) return cipher;
    }
    const col = typeof connection.shop_cipher === 'string' ? connection.shop_cipher.trim() : '';
    if (col && col === h) return col;
    if (ext && h === ext && !h.startsWith('ROW_') && tiktokStoredIdLooksLikeShopCipher(h)) return h;
    // Explicit cipher from search/tools — prefer over stale column / metadata fallbacks.
    if (tiktokStoredIdLooksLikeShopCipher(h)) return h;
  }

  if (typeof connection.shop_cipher === 'string' && connection.shop_cipher.trim()) {
    return connection.shop_cipher.trim();
  }

  const direct = meta.shop_cipher ?? meta.cipher;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const cipher = (item as Record<string, unknown>).cipher;
    if (typeof cipher === 'string' && cipher.trim()) return cipher.trim();
  }

  const extOnly = typeof connection.external_shop_id === 'string' ? connection.external_shop_id.trim() : '';
  if (extOnly && !extOnly.startsWith('ROW_') && tiktokStoredIdLooksLikeShopCipher(extOnly)) return extOnly;

  return null;
}

/**
 * Distinct `shop_cipher` values for TikTok API calls (order search, products, etc.).
 *
 * When `raw_metadata.shops` lists authorized shops, use **only those ciphers** — merging
 * `marketplace_connections.shop_cipher` or `external_shop_id` into that list often injects
 * seller `open_id` or a stale default and triggers 106011 Invalid shop_cipher.
 *
 * If there is no shops array (or it has no ciphers), fall back to `resolveTiktokShopCipher`.
 */
export function listTiktokShopCiphers(connection: MarketplaceConnection): string[] {
  const meta = (connection.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];
  const out: string[] = [];
  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const cipher = (item as Record<string, unknown>).cipher;
    if (typeof cipher === 'string' && cipher.trim()) out.push(cipher.trim());
  }
  const seen = new Set<string>();
  const uniq = out.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  if (uniq.length > 0) return uniq;

  const one = resolveTiktokShopCipher(connection);
  return one ? [one] : [];
}

/**
 * Resolve DB connection for tool `shopId`: matches `external_shop_id`, any `shops[].cipher`,
 * or TikTok shop `id` / `code` (e.g. `ROW_…` tokens from listings).
 */
export function findTiktokConnectionForToolShopId(
  conns: MarketplaceConnection[],
  shopId: string,
): MarketplaceConnection | undefined {
  const sid = shopId.trim();
  if (!sid) return undefined;
  const byExt = conns.find((c) => c.external_shop_id === sid);
  if (byExt) return byExt;
  for (const c of conns) {
    if (listTiktokShopCiphers(c).includes(sid)) return c;
    if (tiktokShopMetaReferencesToken(c, sid)) return c;
  }
  // Cipher-looking shopId from search/tools may not be stored in metadata yet.
  if (tiktokStoredIdLooksLikeShopCipher(sid) && conns.length === 1) return conns[0];
  if (tiktokStoredIdLooksLikeShopCipher(sid)) {
    return conns.find((c) => resolveTiktokShopCipher(c, sid) === sid) ?? conns[0];
  }
  return undefined;
}

function tiktokShopMetaReferencesToken(conn: MarketplaceConnection, token: string): boolean {
  const meta = (conn.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];
  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = row.id != null ? String(row.id).trim() : '';
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    const cipher = typeof row.cipher === 'string' ? row.cipher.trim() : '';
    if (token === id || token === code || token === cipher) return true;
  }
  return false;
}

/** Ordered ciphers: hint-resolved first, then every distinct authorized shop cipher. */
export function tiktokCipherPriorityList(connection: MarketplaceConnection, hint?: string | null): string[] {
  const resolved = resolveTiktokShopCipher(connection, hint);
  const fromConn = listTiktokShopCiphers(connection);
  const out: string[] = [];
  if (resolved) out.push(resolved);
  for (const c of fromConn) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Shown when a product tool is called without `shopId`. */
export const PRODUCT_TOOL_SHOP_ID_MSG =
  'Pass shopId from list-marketplace-shops (preferred) or search-products (TikTok: shop id or Seller Center code; Shopee: numeric shop id).';

export function requireProductToolShopId(shopId: unknown): string {
  if (typeof shopId !== 'string' || !shopId.trim()) {
    throw new Error(`shopId is required. ${PRODUCT_TOOL_SHOP_ID_MSG}`);
  }
  return shopId.trim();
}

export function resolveShopeeToolShop(
  conns: MarketplaceConnection[],
  shopId: string,
): { conn: MarketplaceConnection } | { error: string } {
  const conn = conns.find((c) => c.external_shop_id === shopId.trim());
  if (!conn) {
    return { error: `No Shopee connection for shop "${shopId}" on this tenant.` };
  }
  return { conn };
}

/**
 * Map tool `shopId` (from search-products) to one TikTok connection + `shop_cipher`.
 * No probing other connections or ciphers.
 */
export function resolveTiktokToolShop(
  conns: MarketplaceConnection[],
  shopId: string,
): { conn: MarketplaceConnection; shopCipher: string } | { error: string } {
  const sid = shopId.trim();
  const conn = findTiktokConnectionForToolShopId(conns, sid);
  if (!conn) {
    return { error: `No TikTok connection for shop "${sid}" on this tenant.` };
  }
  const shopCipher = resolveTiktokShopCipher(conn, sid);
  if (!shopCipher) {
    return {
      error:
        `TikTok shop "${sid}" has no shop_cipher on this connection. Reconnect TikTok with authorized shops scope.`,
    };
  }
  return { conn, shopCipher };
}

/** Whether this TikTok OAuth grant can mutate products (`partial_edit`, prices, stock, …). */
export function tiktokConnectionHasProductWrite(connection: MarketplaceConnection): boolean {
  const meta = (connection.raw_metadata ?? {}) as Record<string, unknown>;
  const granted = meta.granted_scopes;
  if (Array.isArray(granted)) {
    return (
      granted.includes('seller.product.write') || granted.includes('seller.global_product.write')
    );
  }
  const scope = connection.scope ?? '';
  return scope.includes('seller.product.write') || scope.includes('seller.global_product.write');
}
