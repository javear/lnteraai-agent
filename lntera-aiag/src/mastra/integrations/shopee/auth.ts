import { getShopeeConfig, SHOPEE_PATHS } from './config';
import { signPublic } from './sign';

export interface ShopeeTokenResponse {
  access_token: string;
  refresh_token: string;
  expire_in: number;
  request_id?: string;
  shop_id_list?: number[];
  merchant_id_list?: number[];
  error?: string;
  message?: string;
}

export interface ShopeeExchangeInput {
  code: string;
  shopId: number;
}

export interface ShopeeRefreshInput {
  shopId: number;
  refreshToken: string;
}

/**
 * Build the Shopee shop authorization URL.
 * Seller is redirected here to authorize the app for one of their shops.
 * Shopee will then redirect back to `redirectUrl` with `code` and `shop_id` query params.
 */
export function buildShopeeAuthUrl(state: string): string {
  const cfg = getShopeeConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic({
    partnerId: cfg.partnerId,
    partnerKey: cfg.partnerKey,
    path: SHOPEE_PATHS.authPartner,
    timestamp,
  });

  const url = new URL(cfg.baseUrl + SHOPEE_PATHS.authPartner);
  url.searchParams.set('partner_id', String(cfg.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  url.searchParams.set('redirect', cfg.redirectUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

async function postShopeeAuth(path: string, body: Record<string, unknown>): Promise<ShopeeTokenResponse> {
  const cfg = getShopeeConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${cfg.partnerId}${path}${timestamp}`;
  const sign = signPublic({
    partnerId: cfg.partnerId,
    partnerKey: cfg.partnerKey,
    path,
    timestamp,
  });

  const url = new URL(cfg.baseUrl + path);
  url.searchParams.set('partner_id', String(cfg.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ShopeeTokenResponse;
  if (!res.ok || json.error) {
    const diag = [
      `host=${cfg.baseUrl}`,
      `region=${cfg.region}`,
      `partner_id=${cfg.partnerId}`,
      `timestamp=${timestamp}`,
      `partner_key_len=${cfg.partnerKey.length}`,
      `partner_key_first4=${cfg.partnerKey.slice(0, 4)}`,
      `basestring=${baseString}`,
      `sign=${sign}`,
    ].join(' ');
    throw new Error(
      `Shopee ${path} failed (${res.status}): ${json.error ?? 'unknown'} ${json.message ?? ''} | ${diag}`.trim(),
    );
  }
  return json;
}

/**
 * Exchange the auth `code` from the callback for access + refresh tokens.
 */
export function exchangeShopeeCode(input: ShopeeExchangeInput): Promise<ShopeeTokenResponse> {
  const cfg = getShopeeConfig();
  return postShopeeAuth(SHOPEE_PATHS.tokenGet, {
    code: input.code,
    shop_id: input.shopId,
    partner_id: cfg.partnerId,
  });
}

/**
 * Refresh an access token using the stored refresh token.
 * Shopee rotates the refresh token on every call - always persist the new value.
 */
export function refreshShopeeAccessToken(input: ShopeeRefreshInput): Promise<ShopeeTokenResponse> {
  const cfg = getShopeeConfig();
  return postShopeeAuth(SHOPEE_PATHS.accessTokenGet, {
    refresh_token: input.refreshToken,
    shop_id: input.shopId,
    partner_id: cfg.partnerId,
  });
}
