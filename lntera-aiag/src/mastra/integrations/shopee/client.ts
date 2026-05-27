import { getConnection, requireConnection, updateTokens } from '../shared/supabase';
import type { MarketplaceConnection } from '../shared/types';
import { getShopeeConfig } from './config';
import { refreshShopeeAccessToken } from './auth';
import { signShop } from './sign';

const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<MarketplaceConnection>>();

function lockKey(shopId: string): string {
  return `shopee:${shopId}`;
}

async function getValidConnection(shopIdStr: string): Promise<MarketplaceConnection> {
  const conn = await requireConnection('shopee', shopIdStr);
  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return conn;
  }

  const key = lockKey(shopIdStr);
  let inflight = refreshLocks.get(key);
  if (!inflight) {
    inflight = (async () => {
      const fresh = await getConnection('shopee', shopIdStr);
      if (fresh && new Date(fresh.access_token_expires_at).getTime() - Date.now() > REFRESH_LEEWAY_MS) {
        return fresh;
      }
      const target = fresh ?? conn;
      const result = await refreshShopeeAccessToken({
        shopId: Number(shopIdStr),
        refreshToken: target.refresh_token,
      });
      return updateTokens('shopee', shopIdStr, {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        access_token_expires_at: new Date(Date.now() + result.expire_in * 1000),
      });
    })();
    refreshLocks.set(key, inflight);
    try {
      return await inflight;
    } finally {
      refreshLocks.delete(key);
    }
  }
  return inflight;
}

export interface ShopeeRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ShopeeClient {
  shopId: string;
  get<T = unknown>(path: string, query?: ShopeeRequestOptions['query']): Promise<T>;
  post<T = unknown>(path: string, options?: ShopeeRequestOptions): Promise<T>;
  /**
   * POST helper for endpoints that return either JSON or a binary body (e.g. shipping label PDF).
   */
  postBinaryOrJson(path: string, options?: ShopeeRequestOptions): Promise<
    | { kind: 'json'; data: unknown }
    | { kind: 'binary'; body: Uint8Array; contentType: string | null }
  >;
}

/**
 * Build a thin signed-request client for one Shopee shop.
 * Tokens auto-refresh when within ~5 minutes of expiry.
 */
export async function getShopeeClient(shopId: string | number): Promise<ShopeeClient> {
  const shopIdStr = String(shopId);
  const cfg = getShopeeConfig();

  async function request<T>(method: 'GET' | 'POST', path: string, opts: ShopeeRequestOptions = {}): Promise<T> {
    const conn = await getValidConnection(shopIdStr);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = signShop({
      partnerId: cfg.partnerId,
      partnerKey: cfg.partnerKey,
      path,
      timestamp,
      accessToken: conn.access_token,
      shopId: Number(shopIdStr),
    });

    const url = new URL(cfg.baseUrl + path);
    url.searchParams.set('partner_id', String(cfg.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', conn.access_token);
    url.searchParams.set('shop_id', shopIdStr);
    url.searchParams.set('sign', sign);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const init: RequestInit = { method };
    if (method === 'POST') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body ?? {});
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Shopee ${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || (json && typeof json === 'object' && 'error' in json && (json as { error?: string }).error)) {
      const err = json as { error?: string; message?: string } | null;
      throw new Error(
        `Shopee ${method} ${path} failed (${res.status}): ${err?.error ?? 'unknown'} ${err?.message ?? ''}`.trim(),
      );
    }
    return json as T;
  }

  async function postBinaryOrJson(
    path: string,
    opts: ShopeeRequestOptions = {},
  ): Promise<
    | { kind: 'json'; data: unknown }
    | { kind: 'binary'; body: Uint8Array; contentType: string | null }
  > {
    const conn = await getValidConnection(shopIdStr);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = signShop({
      partnerId: cfg.partnerId,
      partnerKey: cfg.partnerKey,
      path,
      timestamp,
      accessToken: conn.access_token,
      shopId: Number(shopIdStr),
    });

    const url = new URL(cfg.baseUrl + path);
    url.searchParams.set('partner_id', String(cfg.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', conn.access_token);
    url.searchParams.set('shop_id', shopIdStr);
    url.searchParams.set('sign', sign);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    };

    const res = await fetch(url, init);
    const ct = res.headers.get('content-type');
    const isPdf =
      ct?.toLowerCase().includes('pdf') ||
      ct?.toLowerCase().includes('octet-stream') ||
      ct?.toLowerCase().includes('application/x-download');
    if (res.ok && isPdf) {
      const buf = await res.arrayBuffer();
      return { kind: 'binary', body: new Uint8Array(buf), contentType: ct };
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok && text.length > 0) {
        return {
          kind: 'binary',
          body: new TextEncoder().encode(text),
          contentType: ct,
        };
      }
      throw new Error(`Shopee POST ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || (json && typeof json === 'object' && 'error' in json && (json as { error?: string }).error)) {
      const err = json as { error?: string; message?: string } | null;
      throw new Error(
        `Shopee POST ${path} failed (${res.status}): ${err?.error ?? 'unknown'} ${err?.message ?? ''}`.trim(),
      );
    }
    return { kind: 'json', data: json };
  }

  return {
    shopId: shopIdStr,
    get: (path, query) => request('GET', path, { query }),
    post: (path, options) => request('POST', path, options ?? {}),
    postBinaryOrJson,
  };
}
