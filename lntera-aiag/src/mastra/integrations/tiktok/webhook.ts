import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TikTok Shop webhook signature verification.
 *
 * TikTok Shop sends the signature in the `Authorization` header (a plain lowercase-hex HMAC-SHA256 —
 * NOT the `t=,s=` format of TikTok-for-Developers webhooks). The documented Partner Center scheme is
 * `HMAC-SHA256(app_secret, app_key + rawBody)`. We try that first, plus a couple of historical
 * fallbacks, against every candidate header value — and report WHICH scheme matched, so once the logs
 * confirm one we can lock to it and hard-reject mismatches.
 */
export interface TiktokWebhookVerifyInput {
  /** Raw, un-mutated request body string. */
  rawBody: string;
  /** Candidate signature header values to check (e.g. Authorization + X-TTS-Signature). */
  signatures: Array<string | null | undefined>;
  appKey: string;
  appSecret: string;
}

export interface TiktokWebhookVerifyResult {
  ok: boolean;
  reason?: string;
  /** Which candidate scheme matched (for logging → lock-in later). */
  scheme?: string;
}

function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

function eqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function verifyTiktokWebhookSignature(input: TiktokWebhookVerifyInput): TiktokWebhookVerifyResult {
  if (!input.appSecret || !input.appKey) return { ok: false, reason: 'app_config_missing' };
  const provided = input.signatures.map((s) => (s ?? '').trim().toLowerCase()).filter(Boolean);
  if (provided.length === 0) return { ok: false, reason: 'signature_header_missing' };

  // Confirmed scheme (TikTok Shop Partner Center): HMAC-SHA256(app_secret, app_key + rawBody), hex,
  // delivered in the Authorization header. Locked to this single scheme.
  const expected = hmacHex(input.appSecret, `${input.appKey}${input.rawBody}`);
  for (const sig of provided) {
    if (eqHex(sig, expected)) return { ok: true, scheme: 'app_key+body' };
  }
  return { ok: false, reason: 'signature_mismatch' };
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
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;

  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  };

  // Event types differ: order/product-audit events carry `shop_id`; the inventory event (type 68)
  // carries `seller_open_id` (= our connection's external_shop_id) + numeric `seller_id`. We prefer the
  // open id (matches external_shop_id directly) and fall back to the numeric ids (match raw_metadata.shops[].id).
  const shopId = pick(
    obj.seller_open_id,
    obj.open_id,
    obj.shop_id,
    obj.seller_id,
    data.seller_open_id,
    data.open_id,
    data.shop_id,
    data.seller_id,
  );
  const shopCipher = pick(obj.shop_cipher, data.shop_cipher);

  return { shopId, shopCipher };
}
