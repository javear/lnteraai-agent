import { getMastraPublicBaseUrl } from '../integrations/portkey/config';

/**
 * Where the web SPA lives, so server-side redirects and push deep-links land on the right app.
 *
 *  - `WEB_APP_ORIGIN` set (standalone host, e.g. Vercel) → the SPA is at that origin's root.
 *  - unset (legacy monolith) → the SPA is served by this server under `/app`.
 */
function getWebAppOrigin(): string | null {
  const raw = process.env.WEB_APP_ORIGIN?.trim();
  if (!raw) return null;
  // Tolerate a misconfigured multi-value env ("a,b" or "a b" or a stray typo) — take the FIRST entry
  // that parses as an absolute http(s) URL and return its clean origin. A malformed value falls back
  // to null (→ same-origin "/app/..."), never a broken concatenated redirect.
  for (const part of raw.split(/[\s,]+/)) {
    const candidate = part.trim().replace(/\/+$/, '');
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* try the next entry */
    }
  }
  return null;
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * URL to a SPA route for a same-server `c.redirect(...)`. Returns an absolute URL when
 * `WEB_APP_ORIGIN` is set (Vercel), else a relative `/app/...` path (monolith, current behavior).
 */
export function webAppUrl(path: string): string {
  const p = normalizePath(path);
  const origin = getWebAppOrigin();
  return origin ? `${origin}${p}` : `/app${p}`;
}

/**
 * Absolute URL to a SPA route, for contexts that require one (e.g. push notification launch URLs).
 * `WEB_APP_ORIGIN` (Vercel) when set, else `<MASTRA_PUBLIC_BASE_URL>/app/...` (current behavior).
 */
export function webAppAbsoluteUrl(path: string): string {
  const p = normalizePath(path);
  const origin = getWebAppOrigin();
  if (origin) return `${origin}${p}`;
  return `${getMastraPublicBaseUrl()}/app${p}`;
}
