export type ShopeeRegion = 'live' | 'test';

export interface ShopeeConfig {
  partnerId: number;
  partnerKey: string;
  redirectUrl: string;
  region: ShopeeRegion;
  baseUrl: string;
}

const HOST_BY_REGION: Record<ShopeeRegion, string> = {
  live: 'https://partner.shopeemobile.com',
  test: 'https://openplatform.sandbox.test-stable.shopee.sg',
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function getShopeeConfig(): ShopeeConfig {
  const partnerIdRaw = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  const redirectUrl = process.env.SHOPEE_REDIRECT_URL;
  const regionRaw = (process.env.SHOPEE_REGION ?? 'test').toLowerCase();
  const baseUrlOverride = process.env.SHOPEE_BASE_URL?.trim();

  if (!partnerIdRaw || !partnerKey || !redirectUrl) {
    throw new Error(
      'Shopee is not configured. Set SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, and SHOPEE_REDIRECT_URL in your .env.',
    );
  }
  const partnerId = Number(partnerIdRaw);
  if (!Number.isFinite(partnerId)) {
    throw new Error(`SHOPEE_PARTNER_ID must be a number, got "${partnerIdRaw}".`);
  }
  if (regionRaw !== 'live' && regionRaw !== 'test') {
    throw new Error(`SHOPEE_REGION must be "live" or "test", got "${regionRaw}".`);
  }

  const baseUrl = stripTrailingSlash(baseUrlOverride && baseUrlOverride.length > 0
    ? baseUrlOverride
    : HOST_BY_REGION[regionRaw]);

  return {
    partnerId,
    partnerKey,
    redirectUrl,
    region: regionRaw,
    baseUrl,
  };
}

export const SHOPEE_PATHS = {
  authPartner: '/api/v2/shop/auth_partner',
  tokenGet: '/api/v2/auth/token/get',
  accessTokenGet: '/api/v2/auth/access_token/get',
} as const;
