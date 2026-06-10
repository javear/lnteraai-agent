import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GroqOnboardTokenPayload {
  tenantId: string;
  nonce: string;
  issuedAt: number;
}

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

function getSecret(): string {
  const secret =
    process.env.GROQ_ONBOARD_SECRET?.trim() || process.env.OAUTH_STATE_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'GROQ_ONBOARD_SECRET or OAUTH_STATE_SECRET is not set. Required for Groq onboarding links.',
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

export function createGroqOnboardToken(input: {
  tenantId: string;
  ttlMinutes?: number;
}): string {
  const full: GroqOnboardTokenPayload = {
    tenantId: input.tenantId,
    nonce: base64url(randomBytes(16)),
    issuedAt: Date.now(),
  };
  const body = base64url(JSON.stringify(full));
  return `${body}.${sign(body)}`;
}

export function verifyGroqOnboardToken(
  token: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): GroqOnboardTokenPayload {
  const [body, mac] = token.split('.');
  if (!body || !mac) {
    throw new Error('Malformed Groq onboard token.');
  }
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid Groq onboard token signature.');
  }

  let parsed: GroqOnboardTokenPayload;
  try {
    parsed = JSON.parse(fromBase64url(body).toString('utf8')) as GroqOnboardTokenPayload;
  } catch {
    throw new Error('Groq onboard token payload is not valid JSON.');
  }

  if (
    typeof parsed.tenantId !== 'string' ||
    !parsed.tenantId ||
    typeof parsed.issuedAt !== 'number' ||
    Date.now() - parsed.issuedAt > maxAgeMs
  ) {
    throw new Error('Groq onboard token has expired or is invalid.');
  }

  return parsed;
}
