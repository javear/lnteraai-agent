import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TikTok Shop webhook signature verification.
 *
 * Per Partner Center docs:
 *   header  = `X-TTS-Signature: <hex>`
 *   message = `${app_secret}${rawBody}`
 *   sig     = lowercase hex HMAC-SHA256(app_secret, message)
 *
 * Note: TikTok prepends the app_secret to the body (and uses app_secret as the HMAC key) —
 * we follow that convention literally so we stay binary-compatible with Partner Center test
 * harnesses.
 */
export interface TiktokWebhookVerifyInput {
  /** Raw, un-mutated request body string. */
  rawBody: string;
  /** Value of the `X-TTS-Signature` (or compatible) header. */
  signatureHeader: string | null;
  /** TikTok Shop app secret (from `TIKTOK_APP_SECRET`). */
  appSecret: string;
}

export interface TiktokWebhookVerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyTiktokWebhookSignature(input: TiktokWebhookVerifyInput): TiktokWebhookVerifyResult {
  if (!input.appSecret) return { ok: false, reason: 'app_secret_missing' };
  if (!input.signatureHeader) return { ok: false, reason: 'signature_header_missing' };

  const provided = input.signatureHeader.trim().toLowerCase();
  const expected = createHmac('sha256', input.appSecret)
    .update(`${input.appSecret}${input.rawBody}`)
    .digest('hex');

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
 * Extract the tenant-routing TikTok `shop_id` from a webhook payload.
 *
 * TikTok payload shapes vary slightly between event types but the shop id always lives at
 * `data.shop_id` and the legacy envelope also surfaces a top-level `shop_id`. Some Partner
 * Center revisions add `shop_cipher` next to it — when present we return it as a hint so
 * downstream code can prefer cipher-based lookup (matches what we already store).
 */
export interface TiktokWebhookShopIdentity {
  shopId: string | null;
  shopCipher: string | null;
}

export function extractTiktokShopIdentity(payload: unknown): TiktokWebhookShopIdentity {
  if (!payload || typeof payload !== 'object') return { shopId: null, shopCipher: null };
  const obj = payload as Record<string, unknown>;

  let shopId: string | null = null;
  let shopCipher: string | null = null;

  const top = obj.shop_id;
  if (typeof top === 'number' && Number.isFinite(top)) shopId = String(top);
  else if (typeof top === 'string' && top.trim()) shopId = top.trim();

  const topCipher = obj.shop_cipher;
  if (typeof topCipher === 'string' && topCipher.trim()) shopCipher = topCipher.trim();

  const data = obj.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (!shopId) {
      const v = d.shop_id;
      if (typeof v === 'number' && Number.isFinite(v)) shopId = String(v);
      else if (typeof v === 'string' && v.trim()) shopId = v.trim();
    }
    if (!shopCipher) {
      const v = d.shop_cipher;
      if (typeof v === 'string' && v.trim()) shopCipher = v.trim();
    }
  }

  return { shopId, shopCipher };
}
