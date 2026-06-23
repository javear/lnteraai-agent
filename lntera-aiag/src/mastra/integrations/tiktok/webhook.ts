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

  // Documented scheme first, then fallbacks (raw body; legacy app_secret-prefixed).
  const candidates: Array<{ scheme: string; value: string }> = [
    { scheme: 'app_key+body', value: hmacHex(input.appSecret, `${input.appKey}${input.rawBody}`) },
    { scheme: 'body', value: hmacHex(input.appSecret, input.rawBody) },
    { scheme: 'app_secret+body', value: hmacHex(input.appSecret, `${input.appSecret}${input.rawBody}`) },
  ];
  for (const cand of candidates) {
    for (const sig of provided) {
      if (eqHex(sig, cand.value)) return { ok: true, scheme: cand.scheme };
    }
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
