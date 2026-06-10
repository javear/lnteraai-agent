import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import {
  DEFAULT_JWT_TTL_SEC,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './constants';

const encoder = new TextEncoder();

/**
 * The raw `OPENAPI_JWT_SECRET` string. Single source of truth for the shared
 * HS256 secret used to sign/verify our tenant JWTs — also consumed by the Mastra
 * server auth provider (MastraJwtAuth) so one secret guards /svc/v1 and /api/*.
 */
export function getOpenApiJwtSecret(): string {
  const name = 'OPENAPI_JWT_SECRET';
  const raw = process.env[name]?.trim();
  if (!raw) {
    throw new Error(
      `${name} is missing or empty. It is separate from Supabase keys — add it to the Mastra process env (e.g. lntera-aiag/.env) with a strong random value.`,
    );
  }
  if (raw.length < 16) {
    throw new Error(
      `${name} is too short (${raw.length} chars after trim; need at least 16). Example: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return raw;
}

function requireJwtSecret(): Uint8Array {
  return encoder.encode(getOpenApiJwtSecret());
}

export interface OpenApiAccessClaims extends JWTPayload {
  sub: string;
  tenant_slug?: string;
}

/** Upper bound (and default) for access token lifetime, from env or built-in default. */
export function getMaxJwtTtlSeconds(): number {
  const envParsed = Number.parseInt(process.env.OPENAPI_JWT_TTL_SECONDS ?? '', 10);
  return Number.isFinite(envParsed) && envParsed > 0 ? envParsed : DEFAULT_JWT_TTL_SEC;
}

export async function signOpenApiAccessToken(input: {
  tenantId: string;
  tenantSlug?: string | null;
  /** If set, lifetime is clamped to 1 .. getMaxJwtTtlSeconds(). */
  ttlSeconds?: number;
}): Promise<{ token: string; expiresIn: number }> {
  const secret = requireJwtSecret();
  const maxTtl = getMaxJwtTtlSeconds();
  let ttl = maxTtl;
  if (input.ttlSeconds !== undefined && Number.isFinite(input.ttlSeconds)) {
    const requested = Math.floor(input.ttlSeconds);
    if (requested > 0) {
      ttl = Math.min(requested, maxTtl);
    }
  }
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    tenant_slug: input.tenantSlug ?? undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.tenantId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret);

  return { token: jwt, expiresIn: ttl };
}

export async function verifyOpenApiAccessToken(token: string): Promise<OpenApiAccessClaims> {
  const secret = requireJwtSecret();
  const { payload } = await jwtVerify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  });

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) {
    throw new Error('Invalid token: missing sub');
  }

  return payload as OpenApiAccessClaims;
}
