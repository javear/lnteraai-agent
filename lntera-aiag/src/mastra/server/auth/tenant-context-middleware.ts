import type { MiddlewareHandler } from 'hono';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { tenantFromBearerToken } from '../open-api/middleware/bearer-tenant';

/** RequestContext key carrying the authenticated end-user id (Supabase auth.users.id). */
export const AUTH_USER_ID_KEY = 'auth_user_id';

interface RequestContextLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface AuthedUser {
  sub?: string; // static service JWT → tenant id
  id?: string; // Supabase user → auth.users.id
  app_metadata?: { tenant_id?: string };
}

/**
 * Bridges the authenticated identity into the request context on `/api/*`:
 *  - `tenant_master_id` (+ `MASTRA_RESOURCE_ID_KEY`) — tenant scoping for tools & memory.
 *    Supabase user tokens carry the tenant in `app_metadata.tenant_id`; static service JWTs
 *    carry it in `sub`. We `.set()` unconditionally after auth, so the verified token always
 *    overrides any client-supplied value (anti-spoof).
 *  - `auth_user_id` — the end-user id, used by the agent to resolve role-based tool access.
 *    Only set for real users (Supabase tokens); service JWTs have no user → full tool access.
 *
 * In local dev auth is disabled, so there is no `user`. We still prefer the logged-in tenant
 * by resolving the Supabase bearer the web app sends; `MASTRA_DEV_TENANT_ID` is only the
 * fallback for the Studio playground (which sends no user token).
 */
export const tenantContextMiddleware: MiddlewareHandler = async (c, next) => {
  const rc = c.get('requestContext') as RequestContextLike | undefined;
  if (rc) {
    // 1) Preferred: the tenant from the user the auth provider attached to requestContext.
    const user = rc.get('user') as AuthedUser | undefined;
    let tenant = user?.app_metadata?.tenant_id ?? user?.sub;
    let authUserId = user?.app_metadata?.tenant_id ? (user.id ?? user.sub) : undefined;

    // 2) Fallback: verify the bearer token ourselves (same path /svc/v1 uses). This is the source
    //    of truth when the auth'd user isn't surfaced on requestContext (some deploy/auth setups),
    //    and in local dev where /api auth is off. The token is verified here, so this never trusts
    //    a client-supplied value. Studio playground (no token) → MASTRA_DEV_TENANT_ID.
    if (!(typeof tenant === 'string' && tenant.trim() !== '')) {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1]?.trim();
      const resolved = bearer ? await tenantFromBearerToken(bearer).catch(() => null) : null;
      tenant = resolved?.tenantId ?? process.env.MASTRA_DEV_TENANT_ID?.trim();
      if (resolved?.authUserId) authUserId = resolved.authUserId;
    }

    if (typeof tenant === 'string' && tenant.trim() !== '') {
      rc.set(TENANT_MASTER_ID_KEY, tenant.trim());
      rc.set(MASTRA_RESOURCE_ID_KEY, tenant.trim());
      if (typeof authUserId === 'string' && authUserId.trim() !== '') {
        rc.set(AUTH_USER_ID_KEY, authUserId.trim());
      }
    }
  }
  await next();
};
