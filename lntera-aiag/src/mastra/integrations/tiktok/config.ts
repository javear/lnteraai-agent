export interface TiktokConfig {
  appKey: string;
  appSecret: string;
  redirectUrl: string;
  authBase: string;
  apiBase: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const DEFAULT_TIKTOK_AUTH_BASE = 'https://auth.tiktok-shops.com';
const DEFAULT_TIKTOK_API_BASE = 'https://open-api.tiktokglobalshop.com';

export function getTiktokConfig(): TiktokConfig {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  const redirectUrl = process.env.TIKTOK_REDIRECT_URL;
  const authBaseOverride = process.env.TIKTOK_AUTH_BASE_URL?.trim();
  const apiBaseOverride = process.env.TIKTOK_API_BASE_URL?.trim();

  if (!appKey || !appSecret || !redirectUrl) {
    throw new Error(
      'TikTok is not configured. Set TIKTOK_APP_KEY, TIKTOK_APP_SECRET, and TIKTOK_REDIRECT_URL in your .env.',
    );
  }

  return {
    appKey,
    appSecret,
    redirectUrl,
    authBase: stripTrailingSlash(authBaseOverride && authBaseOverride.length > 0 ? authBaseOverride : DEFAULT_TIKTOK_AUTH_BASE),
    apiBase: stripTrailingSlash(apiBaseOverride && apiBaseOverride.length > 0 ? apiBaseOverride : DEFAULT_TIKTOK_API_BASE),
  };
}

export const TIKTOK_PATHS = {
  authorize: '/oauth/authorize',
  tokenGet: '/api/v2/token/get',
  tokenRefresh: '/api/v2/token/refresh',
} as const;
