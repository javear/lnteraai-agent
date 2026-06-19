import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Platform } from './types';

/** Marketplace OAuth + Discord bot install (state-signed flows). */
export type OAuthStatePlatform = Platform | 'discord';

export interface StatePayload {
  platform: OAuthStatePlatform;
  tenantId?: string | null;
  nonce: string;
  issuedAt: number;
}

const MAX_AGE_MS = 10 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error(
      'OAUTH_STATE_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(payloadB64: string): string {
  return base64url(createHmac('sha256', getSecret()).update(payloadB64).digest());
}

export function createState(
  payload: Omit<StatePayload, 'nonce' | 'issuedAt'> & Partial<Pick<StatePayload, 'nonce'>>,
): string {
  const full: StatePayload = {
    platform: payload.platform,
    tenantId: payload.tenantId ?? null,
    nonce: payload.nonce ?? base64url(randomBytes(16)),
    issuedAt: Date.now(),
  };
  const body = base64url(JSON.stringify(full));
  return `${body}.${sign(body)}`;
}

export function verifyState(state: string): StatePayload {
  const [body, mac] = state.split('.');
  if (!body || !mac) {
    throw new Error('Malformed state parameter.');
  }
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid state signature.');
  }
  let parsed: StatePayload;
  try {
    parsed = JSON.parse(fromBase64url(body).toString('utf8')) as StatePayload;
  } catch {
    throw new Error('State payload is not valid JSON.');
  }
  if (typeof parsed.issuedAt !== 'number' || Date.now() - parsed.issuedAt > MAX_AGE_MS) {
    throw new Error('State parameter has expired.');
  }
  return parsed;
}

/**
 * First-party cookie that carries the signed state across the provider round-trip. Required because
 * Shopee does NOT echo the `state` query param back to the redirect (it appends only code + shop_id),
 * so the callback would otherwise have no tenant context. SameSite=Lax → sent on the top-level GET
 * redirect back from the provider; the signed value keeps the tenant binding tamper-proof.
 */
export const OAUTH_STATE_COOKIE = 'lntera_oauth_state';

/** Minimal Hono-context shape (avoids coupling to Mastra's bundled Hono types). */
interface CookieCtx {
  req: { header(name: string): string | undefined };
  header(name: string, value: string): void;
}

function cookieAttrs(maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function setOAuthStateCookie(c: CookieCtx, state: string): void {
  // state is base64url(body).base64url(sig) — all cookie-safe chars, no encoding needed.
  c.header('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; ${cookieAttrs(600)}`);
}

export function readOAuthStateCookie(c: CookieCtx): string | null {
  const raw = c.req.header('cookie') ?? '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === OAUTH_STATE_COOKIE) return part.slice(idx + 1).trim() || null;
  }
  return null;
}

export function clearOAuthStateCookie(c: CookieCtx): void {
  c.header('Set-Cookie', `${OAUTH_STATE_COOKIE}=; ${cookieAttrs(0)}`);
}
