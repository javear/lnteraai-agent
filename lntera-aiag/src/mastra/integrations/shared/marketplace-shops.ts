import type { TiktokAuthorizedShop } from '../tiktok/auth';
import { getTiktokAuthorizedShops } from '../tiktok/auth';
import { getShopeeClient } from '../shopee/client';
import { getShopeeShopInfo } from '../shopee/shop-info';
import { listConnectionsByTenant, patchConnectionProfile } from './supabase';
import type { MarketplaceConnection, Platform, Uuid } from './types';

export type MarketplaceShopStatus = 'ready' | 'needs_reconnect';

export interface SanitizedMarketplaceShop {
  platform: Platform;
  shopId: string;
  name: string | null;
  region: string | null;
  shopCode?: string;
  status: MarketplaceShopStatus;
}

export interface ListTenantMarketplaceShopsResult {
  shops: SanitizedMarketplaceShop[];
  summary: {
    total: number;
    shopee: number;
    tiktok: number;
    needsReconnect: number;
  };
  refreshed?: boolean;
  refreshErrors?: Array<{ platform: Platform; shopId?: string; message: string }>;
}

interface TiktokShopMetaEntry {
  id: string;
  code: string;
  name: string | null;
  region: string | null;
}

const TOKEN_LEEWAY_MS = 60_000;

function connectionTokenExpired(conn: MarketplaceConnection): boolean {
  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  return expiresAt - Date.now() <= TOKEN_LEEWAY_MS;
}

function parseTiktokShopMetaEntries(conn: MarketplaceConnection): TiktokShopMetaEntry[] {
  const meta = (conn.raw_metadata ?? {}) as Record<string, unknown>;
  const shopsRaw = meta.tiktok_shops ?? meta.shops;
  const shops: unknown[] = Array.isArray(shopsRaw) ? shopsRaw : [];
  const out: TiktokShopMetaEntry[] = [];

  for (const item of shops) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = row.id != null ? String(row.id).trim() : '';
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() || null : null;
    const region = typeof row.region === 'string' ? row.region.trim() || null : null;
    if (!id && !code) continue;
    out.push({ id, code, name, region });
  }
  return out;
}

function publicTiktokShopId(entry: TiktokShopMetaEntry): string | null {
  if (entry.id) return entry.id;
  if (entry.code) return entry.code;
  return null;
}

function sanitizeTiktokRow(
  entry: TiktokShopMetaEntry,
  tokenExpired: boolean,
): SanitizedMarketplaceShop | null {
  const shopId = publicTiktokShopId(entry);
  if (!shopId) return null;

  const shopCode =
    entry.id && entry.code && entry.code !== shopId ? entry.code : undefined;

  return {
    platform: 'tiktok',
    shopId,
    name: entry.name,
    region: entry.region,
    ...(shopCode ? { shopCode } : {}),
    status: tokenExpired ? 'needs_reconnect' : 'ready',
  };
}

function sanitizeShopeeRow(conn: MarketplaceConnection): SanitizedMarketplaceShop {
  const tokenExpired = connectionTokenExpired(conn);
  return {
    platform: 'shopee',
    shopId: conn.external_shop_id,
    name: conn.shop_name,
    region: conn.region,
    status: tokenExpired ? 'needs_reconnect' : 'ready',
  };
}

function sanitizeTiktokFromConnection(conn: MarketplaceConnection): SanitizedMarketplaceShop[] {
  const tokenExpired = connectionTokenExpired(conn);
  const entries = parseTiktokShopMetaEntries(conn);
  const rows: SanitizedMarketplaceShop[] = [];

  for (const entry of entries) {
    const row = sanitizeTiktokRow(entry, tokenExpired);
    if (row) rows.push(row);
  }

  if (rows.length === 0) {
    rows.push({
      platform: 'tiktok',
      shopId: 'pending-setup',
      name: conn.shop_name,
      region: conn.region,
      status: 'needs_reconnect',
    });
  }

  return rows;
}

function buildSummary(shops: SanitizedMarketplaceShop[]): ListTenantMarketplaceShopsResult['summary'] {
  let shopee = 0;
  let tiktok = 0;
  let needsReconnect = 0;
  for (const s of shops) {
    if (s.platform === 'shopee') shopee++;
    else tiktok++;
    if (s.status === 'needs_reconnect') needsReconnect++;
  }
  return { total: shops.length, shopee, tiktok, needsReconnect };
}

function mergeTiktokShopsMetadata(
  existing: Record<string, unknown>,
  freshShops: TiktokAuthorizedShop[],
): Record<string, unknown> {
  return {
    ...existing,
    shops: freshShops,
    tiktok_shops: freshShops,
  };
}

function shopeeProfileIncomplete(conn: MarketplaceConnection): boolean {
  return !conn.shop_name?.trim();
}

function mergeRefreshedConnections(
  connections: MarketplaceConnection[],
  refreshed: MarketplaceConnection[],
): MarketplaceConnection[] {
  const byKey = new Map<string, MarketplaceConnection>();
  for (const c of refreshed) {
    byKey.set(`${c.platform}:${c.external_shop_id}`, c);
  }
  return connections.map((c) => byKey.get(`${c.platform}:${c.external_shop_id}`) ?? c);
}

async function refreshShopeeConnections(
  connections: MarketplaceConnection[],
  refreshErrors: NonNullable<ListTenantMarketplaceShopsResult['refreshErrors']>,
): Promise<MarketplaceConnection[]> {
  const updated: MarketplaceConnection[] = [];
  for (const conn of connections) {
    try {
      const client = await getShopeeClient(conn.external_shop_id);
      const info = await getShopeeShopInfo(client);
      const patched = await patchConnectionProfile('shopee', conn.external_shop_id, {
        shop_name: info.shopName ?? conn.shop_name,
        region: info.region ?? conn.region,
      });
      updated.push(patched);
    } catch (err) {
      refreshErrors.push({
        platform: 'shopee',
        shopId: conn.external_shop_id,
        message: (err as Error).message,
      });
      updated.push(conn);
    }
  }
  return updated;
}

async function refreshTiktokConnections(
  connections: MarketplaceConnection[],
  refreshErrors: NonNullable<ListTenantMarketplaceShopsResult['refreshErrors']>,
): Promise<MarketplaceConnection[]> {
  const updated: MarketplaceConnection[] = [];
  for (const conn of connections) {
    try {
      const authorized = await getTiktokAuthorizedShops(conn.access_token);
      const meta = (conn.raw_metadata ?? {}) as Record<string, unknown>;
      const patched = await patchConnectionProfile('tiktok', conn.external_shop_id, {
        shop_name: authorized[0]?.name ?? conn.shop_name,
        region: authorized[0]?.region ?? conn.region,
        raw_metadata: mergeTiktokShopsMetadata(meta, authorized),
      });
      updated.push(patched);
    } catch (err) {
      refreshErrors.push({
        platform: 'tiktok',
        message: (err as Error).message,
      });
      updated.push(conn);
    }
  }
  return updated;
}

function flattenConnections(connections: MarketplaceConnection[]): SanitizedMarketplaceShop[] {
  const shops: SanitizedMarketplaceShop[] = [];
  for (const conn of connections) {
    if (conn.platform === 'shopee') {
      shops.push(sanitizeShopeeRow(conn));
    } else {
      shops.push(...sanitizeTiktokFromConnection(conn));
    }
  }
  return shops;
}

function resolvePlatforms(platform?: 'both' | Platform): Platform[] | undefined {
  if (!platform || platform === 'both') return undefined;
  return [platform];
}

/**
 * List all marketplace shops for a tenant (sanitized — no tokens, cipher, or open_id).
 */
export async function listTenantMarketplaceShops(args: {
  tenantId: Uuid;
  platform?: 'both' | Platform;
  refresh?: boolean;
}): Promise<ListTenantMarketplaceShopsResult> {
  const platforms = resolvePlatforms(args.platform);
  let connections = await listConnectionsByTenant(args.tenantId, platforms);

  const refreshErrors: NonNullable<ListTenantMarketplaceShopsResult['refreshErrors']> = [];
  let refreshed = false;

  if (args.refresh) {
    refreshed = true;
    const shopeeConns = connections.filter((c) => c.platform === 'shopee');
    const tiktokConns = connections.filter((c) => c.platform === 'tiktok');

    const refreshedShopee = shopeeConns.length
      ? await refreshShopeeConnections(shopeeConns, refreshErrors)
      : [];
    const refreshedTiktok = tiktokConns.length
      ? await refreshTiktokConnections(tiktokConns, refreshErrors)
      : [];

    connections = mergeRefreshedConnections(connections, [...refreshedShopee, ...refreshedTiktok]);
  } else {
    const shopeeMissingName = connections.filter(
      (c) => c.platform === 'shopee' && shopeeProfileIncomplete(c),
    );
    if (shopeeMissingName.length > 0) {
      const enriched = await refreshShopeeConnections(shopeeMissingName, refreshErrors);
      connections = mergeRefreshedConnections(connections, enriched);
    }
  }

  const shops = flattenConnections(connections);
  const result: ListTenantMarketplaceShopsResult = {
    shops,
    summary: buildSummary(shops),
  };
  if (refreshed) result.refreshed = true;
  if (refreshErrors.length > 0) result.refreshErrors = refreshErrors;
  return result;
}
