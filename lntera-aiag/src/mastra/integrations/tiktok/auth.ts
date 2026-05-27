import { getTiktokConfig, TIKTOK_PATHS } from './config';
import { signTiktok } from './sign';

export interface TiktokTokenData {
  access_token: string;
  access_token_expire_in: number;
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  granted_scopes?: string[];
}

export interface TiktokTokenEnvelope {
  code: number;
  message: string;
  request_id?: string;
  data?: TiktokTokenData;
}

export interface TiktokAuthorizedShop {
  id?: string;
  cipher?: string;
  code?: string;
  name?: string;
  region?: string;
}

interface TiktokAuthorizedShopsEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    shops?: TiktokAuthorizedShop[];
  };
}

/**
 * Build the TikTok Shop seller authorization URL.
 * Seller is redirected here, picks a shop, and TikTok redirects back to
 * `redirectUrl` with `code` and `state` (and `app_key`) query params.
 */
export function buildTiktokAuthUrl(state: string): string {
  const cfg = getTiktokConfig();
  const url = new URL(cfg.authBase + TIKTOK_PATHS.authorize);
  url.searchParams.set('app_key', cfg.appKey);
  url.searchParams.set('state', state);
  return url.toString();
}

async function getTiktokAuth(path: string, query: Record<string, string>): Promise<TiktokTokenData> {
  const cfg = getTiktokConfig();
  const url = new URL(cfg.authBase + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  // Token endpoints take credentials in the query string and are NOT signed.
  url.searchParams.set('app_key', cfg.appKey);
  url.searchParams.set('app_secret', cfg.appSecret);

  const res = await fetch(url, { method: 'GET' });
  const json = (await res.json()) as TiktokTokenEnvelope;
  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error(`TikTok ${path} failed (${res.status}): code=${json.code} ${json.message}`);
  }
  return json.data;
}

export function exchangeTiktokCode(authCode: string): Promise<TiktokTokenData> {
  return getTiktokAuth(TIKTOK_PATHS.tokenGet, {
    auth_code: authCode,
    grant_type: 'authorized_code',
  });
}

export function refreshTiktokAccessToken(refreshToken: string): Promise<TiktokTokenData> {
  return getTiktokAuth(TIKTOK_PATHS.tokenRefresh, {
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

/**
 * Fetch authorized shops for the current access token.
 * Requires the app/token to include the authorization shops-read scope.
 */
export async function getTiktokAuthorizedShops(accessToken: string): Promise<TiktokAuthorizedShop[]> {
  const cfg = getTiktokConfig();
  const path = '/authorization/202309/shops';
  const timestamp = Math.floor(Date.now() / 1000);
  const query: Record<string, string | number | boolean | undefined> = {
    app_key: cfg.appKey,
    timestamp,
  };

  const sign = signTiktok({
    appSecret: cfg.appSecret,
    path,
    query,
  });

  const url = new URL(cfg.apiBase + path);
  url.searchParams.set('app_key', cfg.appKey);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);

  const tokenTail = accessToken.length > 10 ? accessToken.slice(-10) : accessToken;
  console.info(
    `[TikTok] Requesting authorized shops: method=GET path=${path} app_key=${cfg.appKey} token_tail=${tokenTail}`,
  );

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-tts-access-token': accessToken,
    },
  });

  const text = await res.text();
  console.info(
    `[TikTok] Authorized shops HTTP response: status=${res.status} body_preview=${text.slice(0, 500)}`,
  );
  let json: TiktokAuthorizedShopsEnvelope;
  try {
    json = (text ? JSON.parse(text) : {}) as TiktokAuthorizedShopsEnvelope;
  } catch {
    throw new Error(`TikTok ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  console.info(
    `[TikTok] Authorized shops parsed envelope: code=${json.code ?? 'n/a'} message=${json.message ?? ''} request_id=${json.request_id ?? 'n/a'}`,
  );

  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    console.warn(
      `[TikTok] Authorized shops failed: status=${res.status} code=${json.code ?? 'n/a'} message=${json.message ?? ''}`,
    );
    throw new Error(
      `TikTok GET ${path} failed (${res.status}): code=${json.code ?? 'n/a'} ${json.message ?? ''}`.trim(),
    );
  }

  const shops = json.data?.shops ?? [];
  console.info(`[TikTok] Authorized shops success: count=${shops.length}`);
  return shops;
}
