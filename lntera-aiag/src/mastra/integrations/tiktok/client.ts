import { getConnection, requireConnection, updateTokens } from '../shared/supabase';
import type { MarketplaceConnection } from '../shared/types';
import { getTiktokConfig } from './config';
import { refreshTiktokAccessToken } from './auth';
import { signTiktok } from './sign';
import JSONbig from 'json-bigint';

const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<MarketplaceConnection>>();

/** TikTok order/package ids can exceed `Number.MAX_SAFE_INTEGER`; keep them as strings in JSON. */
const parseTiktokJson = JSONbig({ storeAsString: true });

/** TikTok Shop gateway validates the token on this header (not only query). */
const TTS_ACCESS_TOKEN_HEADER = 'x-tts-access-token';


function lockKey(shopId: string): string {
  return `tiktok:${shopId}`;
}

/** Call TikTok token/refresh and persist; use when access token is invalid or near expiry. */
async function refreshAndPersistTiktokTokens(shopId: string): Promise<MarketplaceConnection> {
  const target = await requireConnection('tiktok', shopId);
  const result = await refreshTiktokAccessToken(target.refresh_token);
  return updateTokens('tiktok', shopId, {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    access_token_expires_at: new Date(Date.now() + result.access_token_expire_in * 1000),
    refresh_token_expires_at: new Date(Date.now() + result.refresh_token_expire_in * 1000),
  });
}

function isTiktokExpiredCredentialError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\bcode=105002\b/.test(msg) ||
    /Expired credentials/i.test(msg) ||
    /\baccess_token\b.*expired/i.test(msg) ||
    /\bx-tts-access-token\b.*expired/i.test(msg)
  );
}

/**
 * Serialize refresh for one shop (proactive near-expiry + reactive 105002) so concurrent
 * callers share one TikTok refresh and one DB write.
 */
async function withTikTokRefreshLock(
  shopId: string,
  refresh: () => Promise<MarketplaceConnection>,
): Promise<MarketplaceConnection> {
  const key = lockKey(shopId);
  let inflight = refreshLocks.get(key);
  if (!inflight) {
    inflight = refresh();
    refreshLocks.set(key, inflight);
    try {
      return await inflight;
    } finally {
      refreshLocks.delete(key);
    }
  }
  return inflight;
}

async function getValidConnection(shopId: string): Promise<MarketplaceConnection> {
  const conn = await requireConnection('tiktok', shopId);
  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return conn;
  }

  return withTikTokRefreshLock(shopId, async () => {
    const fresh = await getConnection('tiktok', shopId);
    if (fresh && new Date(fresh.access_token_expires_at).getTime() - Date.now() > REFRESH_LEEWAY_MS) {
      return fresh;
    }
    return refreshAndPersistTiktokTokens(shopId);
  });
}

/** After API 105002 / “Expired credentials”, always hit token/refresh even if DB expiry looks valid. */
async function refreshTiktokAfterCredentialRejected(shopId: string): Promise<MarketplaceConnection> {
  return withTikTokRefreshLock(shopId, () => refreshAndPersistTiktokTokens(shopId));
}

interface SignedRequestParams {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** When false, never add shop_cipher (required for /authorization/...). Default true. */
  includeShopCipher?: boolean;
  /** Explicit cipher override (e.g. multi-shop). */
  shopCipher?: string;
  /**
   * When set, send raw bytes (e.g. multipart) instead of JSON. The caller is
   * responsible for choosing the correct content type and `body` is ignored.
   */
  rawBody?: { contentType: string; body: Buffer | Uint8Array };
}

/**
 * Whether to attach `shop_cipher` to the query string. Seller-token endpoints like
 * image/file upload must omit it (TikTok 36009004 if present).
 */
function tiktokPathIncludesShopCipher(path: string): boolean {
  if (/^\/(authorization|seller)\/\d{6}\//.test(path)) return false;
  if (/\/product\/\d{6}\/(images|files)\/upload\/?$/.test(path)) return false;
  return true;
}

/**
 * Signed TikTok Open API request. Access token is sent only via `x-tts-access-token`
 * (see partner SDKs); do not put `access_token` in the query string.
 */
async function signedTiktokRequest<T>(
  conn: MarketplaceConnection,
  params: SignedRequestParams,
): Promise<T> {
  const cfg = getTiktokConfig();
  const method = params.method;
  const path = params.path;
  const includeShopCipher = params.includeShopCipher !== false;

  const query: Record<string, string | number | boolean | undefined> = {
    app_key: cfg.appKey,
    timestamp: Math.floor(Date.now() / 1000),
    ...(params.query ?? {}),
  };

  if (includeShopCipher) {
    const cipher =
      params.shopCipher
      ?? conn.shop_cipher
      ?? (conn.raw_metadata as { shop_cipher?: string } | null)?.shop_cipher;
    if (cipher) query.shop_cipher = cipher;
  }

  const url = new URL(cfg.apiBase + path);
  const hasJsonBody = method === 'POST' || method === 'PUT';
  let bodyString: string | undefined;
  let contentType: string | undefined;
  let rawBodyBuffer: Buffer | Uint8Array | undefined;
  if (params.rawBody) {
    contentType = params.rawBody.contentType;
    rawBodyBuffer = params.rawBody.body;
  } else if (hasJsonBody) {
    contentType = 'application/json';
    bodyString = JSON.stringify(params.body ?? {});
  }

  const sign = signTiktok({
    appSecret: cfg.appSecret,
    path,
    query,
    body: bodyString,
    contentType,
  });

  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('sign', sign);

  const headers: Record<string, string> = {
    [TTS_ACCESS_TOKEN_HEADER]: conn.access_token,
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const init: RequestInit = { method, headers };
  if (rawBodyBuffer) {
    init.body = rawBodyBuffer as unknown as BodyInit;
  } else if (hasJsonBody) {
    init.body = bodyString;
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? parseTiktokJson.parse(text) : null;
  } catch {
    throw new Error(`TikTok ${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  const envelope = json as { code?: number; message?: string } | null;
  if (!res.ok || (envelope && typeof envelope.code === 'number' && envelope.code !== 0)) {
    throw new Error(
      `TikTok ${method} ${path} failed (${res.status}): code=${envelope?.code ?? 'n/a'} ${envelope?.message ?? ''}`.trim(),
    );
  }
  return json as T;
}

export interface TiktokRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Some TikTok APIs require the shop's `cipher` (multi-shop sellers). */
  shopCipher?: string;
}

export interface TiktokMultipartOptions extends Omit<TiktokRequestOptions, 'body'> {
  contentType: string;
  body: Buffer | Uint8Array;
}

export interface TiktokClient {
  shopId: string;
  get<T = unknown>(path: string, options?: Omit<TiktokRequestOptions, 'body'>): Promise<T>;
  post<T = unknown>(path: string, options?: TiktokRequestOptions): Promise<T>;
  put<T = unknown>(path: string, options?: TiktokRequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: TiktokRequestOptions): Promise<T>;
  /** Multipart POST (e.g. image upload) — caller provides framed body. */
  postMultipart<T = unknown>(path: string, options: TiktokMultipartOptions): Promise<T>;
}

/**
 * Build a thin signed-request client for one TikTok Shop seller.
 * `shopId` here is the value you store as `external_shop_id` in Supabase
 * (OAuth `open_id` for seller-scoped tokens).
 *
 * IMPORTANT:
 * - We DO NOT force-fetch `/authorization/202309/shops` automatically, because
 *   many apps/tokens are granted product scopes but not authorization scopes.
 * - If `raw_metadata.shop_cipher` exists, it is attached automatically.
 * - If missing, requests are still sent without `shop_cipher`; callers can pass
 *   `shopCipher` explicitly where required.
 *
 * Tokens auto-refresh when within ~5 minutes of stored expiry, and once more if TikTok
 * returns expired-token errors (e.g. code 105002) so a stale `access_token_expires_at`
 * row still recovers without manual re-auth (until the refresh_token itself expires).
 */
export async function getTiktokClient(shopId: string): Promise<TiktokClient> {
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: TiktokRequestOptions | (TiktokMultipartOptions & { _multipart: true }) = {},
  ): Promise<T> {
    const includeShopCipher = tiktokPathIncludesShopCipher(path);
    const isMultipart = (opts as { _multipart?: true })._multipart === true;
    const rawBody = isMultipart
      ? {
          contentType: (opts as TiktokMultipartOptions).contentType,
          body: (opts as TiktokMultipartOptions).body,
        }
      : undefined;
    const exec = (conn: MarketplaceConnection) =>
      signedTiktokRequest<T>(conn, {
        method,
        path,
        query: opts.query,
        body: isMultipart ? undefined : (opts as TiktokRequestOptions).body,
        shopCipher: opts.shopCipher,
        includeShopCipher,
        rawBody,
      });

    let conn = await getValidConnection(shopId);
    try {
      return await exec(conn);
    } catch (e) {
      if (!isTiktokExpiredCredentialError(e)) throw e;
      conn = await refreshTiktokAfterCredentialRejected(shopId);
      return await exec(conn);
    }
  }

  return {
    shopId,
    get: (path, options) => request('GET', path, options ?? {}),
    post: (path, options) => request('POST', path, options ?? {}),
    put: (path, options) => request('PUT', path, options ?? {}),
    delete: (path, options) => request('DELETE', path, options ?? {}),
    postMultipart: (path, options) => request('POST', path, { ...options, _multipart: true }),
  };
}
