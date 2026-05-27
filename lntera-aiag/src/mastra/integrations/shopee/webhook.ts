import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shopee Push v2 signature verification.
 *
 * Per docs (https://open.shopee.com/documents?module=63&type=2&id=58):
 *   base = `${url}|${rawBody}`
 *   signature = lowercase hex HMAC-SHA256(push_partner_key, base)
 *   header = `Authorization: <signature>`     (older partners use the raw signature)
 *                  or `Authorization: SHA256=<signature>`  (newer partners)
 *
 * `url` must match what Shopee sees, which is the full request URL incl. scheme and host.
 * Because the partner config is what we set in the dashboard, the deployment owner is
 * responsible for setting `SHOPEE_PUSH_PARTNER_KEY` and (optionally) `SHOPEE_PUSH_BASE_URL`
 * when running behind a proxy whose forwarded URL differs from what Mastra reconstructs.
 */
export interface ShopeePushVerifyInput {
  /** Full URL Shopee saw (e.g. https://example.com/webhooks/shopee). */
  url: string;
  /** Raw, un-mutated request body string. */
  rawBody: string;
  /** Value of the `Authorization` header. */
  authorizationHeader: string | null;
  /** Push partner key from Shopee Open Platform → Push Configuration. */
  pushPartnerKey: string;
}

export interface ShopeePushVerifyResult {
  ok: boolean;
  reason?: string;
}

function extractShopeeSignature(header: string): string {
  const trimmed = header.trim();
  const idx = trimmed.toLowerCase().indexOf('sha256=');
  if (idx >= 0) return trimmed.slice(idx + 'sha256='.length).trim();
  return trimmed;
}

export function verifyShopeePushSignature(input: ShopeePushVerifyInput): ShopeePushVerifyResult {
  if (!input.pushPartnerKey) return { ok: false, reason: 'push_partner_key_missing' };
  if (!input.authorizationHeader) return { ok: false, reason: 'authorization_header_missing' };

  const expected = createHmac('sha256', input.pushPartnerKey)
    .update(`${input.url}|${input.rawBody}`)
    .digest('hex');
  const provided = extractShopeeSignature(input.authorizationHeader).toLowerCase();
  if (provided.length !== expected.length) return { ok: false, reason: 'signature_length_mismatch' };

  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'signature_length_mismatch' };
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch {
    return { ok: false, reason: 'signature_decode_failed' };
  }
}

/**
 * Extract the tenant-routing `shop_id` from a Shopee push payload. Shopee always places it
 * at the top level (numeric). Returns the string form for DB equality.
 */
export function extractShopeeShopId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const v = obj.shop_id;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * Reconstruct the URL Shopee saw for signature verification.
 *
 * - Prefer `SHOPEE_PUSH_BASE_URL` (explicit) when set.
 * - Otherwise use forwarded-proto / forwarded-host headers (proxied deployments).
 * - Fallback to the request's own URL.
 */
export function resolveShopeePushUrl(args: {
  reqUrl: string;
  forwardedProto: string | null;
  forwardedHost: string | null;
  host: string | null;
  pathWithQuery: string;
  override: string | null;
}): string {
  if (args.override && args.override.trim()) {
    const base = args.override.replace(/\/+$/, '');
    return `${base}${args.pathWithQuery}`;
  }
  const proto = (args.forwardedProto?.split(',')[0] ?? '').trim() || null;
  const host = (args.forwardedHost?.split(',')[0] ?? '').trim() || args.host || null;
  if (proto && host) return `${proto}://${host}${args.pathWithQuery}`;
  return args.reqUrl;
}
