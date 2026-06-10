import { createHmac } from 'node:crypto';

export interface ShopeeSignParams {
  partnerId: number;
  partnerKey: string;
  path: string;
  timestamp: number;
}

export interface ShopeeShopSignParams extends ShopeeSignParams {
  accessToken: string;
  shopId: number;
}

function hmac(partnerKey: string, baseString: string): string {
  return createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

/**
 * Shopee public/auth signature: partner_id + path + timestamp.
 * Used for /api/v2/shop/auth_partner, /api/v2/auth/token/get, /api/v2/auth/access_token/get.
 */
export function signPublic(p: ShopeeSignParams): string {
  return hmac(p.partnerKey, `${p.partnerId}${p.path}${p.timestamp}`);
}

/**
 * Shopee shop API signature: partner_id + path + timestamp + access_token + shop_id.
 */
export function signShop(p: ShopeeShopSignParams): string {
  return hmac(
    p.partnerKey,
    `${p.partnerId}${p.path}${p.timestamp}${p.accessToken}${p.shopId}`,
  );
}
