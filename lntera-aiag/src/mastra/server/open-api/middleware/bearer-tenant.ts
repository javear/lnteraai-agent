import { verifyOpenApiAccessToken } from '../jwt';
import { getSupabase } from '../../../integrations/shared/supabase';
import { getTenantUserForAuthUser } from '../../../integrations/shared/tenant-users';

/** Minimal shape for Mastra `registerApiRoute` handlers (Hono-compatible). */
export type OpenApiHandlerContext = {
  req: {
    header: (name: string) => string | undefined;
    json: <T = unknown>() => Promise<T>;
  };
  header: (name: string, value: string, options?: { append?: boolean }) => void;
  json: (data: unknown, status?: number) => Response;
  text: (body: string, status?: number) => Response;
};

export function openApiJsonError(
  c: OpenApiHandlerContext,
  status: number,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Verifies `Authorization: Bearer` JWT and returns canonical tenant UUID from `sub`.
 */
export async function requireTenantJwt(
  c: OpenApiHandlerContext,
): Promise<{ tenantId: string } | Response> {
  const token = extractBearer(c.req.header('Authorization'));
  if (!token) {
    return openApiJsonError(c, 401, 'unauthorized', 'Missing or invalid Authorization bearer token.');
  }

  try {
    const claims = await verifyOpenApiAccessToken(token);
    return { tenantId: claims.sub };
  } catch {
    return openApiJsonError(c, 401, 'unauthorized', 'Invalid or expired access token.');
  }
}

export interface BearerTenant {
  tenantId: string;
  /** Present only for Supabase end-user tokens (not the static service JWT). */
  authUserId?: string;
  role?: string;
  source: 'service' | 'user';
}

/**
 * Resolve a tenant from a raw bearer token, accepting EITHER credential — without
 * throwing/returning a Response. Returns null when the token isn't valid.
 *  1. the static service JWT (`verifyOpenApiAccessToken`, local & fast) → `sub`;
 *  2. a Supabase user access token (`auth.getUser`) → `app_metadata.tenant_id` + role.
 */
export async function tenantFromBearerToken(token: string): Promise<BearerTenant | null> {
  if (!token) return null;

  // 1) Static service JWT — local verification, no network.
  try {
    const claims = await verifyOpenApiAccessToken(token);
    return { tenantId: claims.sub, source: 'service' };
  } catch {
    /* not a service token — try Supabase below */
  }

  // 2) Supabase user token — validated against Supabase; tenant lives in app_metadata.
  try {
    const { data, error } = await getSupabase().auth.getUser(token);
    const user = error ? null : data?.user;
    const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
    if (user && tenantId) {
      const membership = await getTenantUserForAuthUser(user.id).catch(() => null);
      return { tenantId, authUserId: user.id, role: membership?.role, source: 'user' };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** The app-facing equivalent of CompositeAuth for custom (`/svc/v1`) routes. */
export async function resolveTenantFromBearer(
  c: OpenApiHandlerContext,
): Promise<BearerTenant | Response> {
  const token = extractBearer(c.req.header('Authorization'));
  if (!token) {
    return openApiJsonError(c, 401, 'unauthorized', 'Missing or invalid Authorization bearer token.');
  }
  const resolved = await tenantFromBearerToken(token);
  if (resolved) return resolved;
  return openApiJsonError(c, 401, 'unauthorized', 'Invalid or expired access token.');
}
