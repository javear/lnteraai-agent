import { CompositeAuth, MastraAuthProvider } from '@mastra/core/server';
import { MastraJwtAuth } from '@mastra/auth';
import { MastraAuthSupabase } from '@mastra/auth-supabase';
import { getOpenApiJwtSecret } from '../open-api/jwt';
import { getSupabasePublishableKey } from '../../integrations/shared/supabase';

/**
 * Server auth for Mastra's native routes (`/api/*`) and the Studio playground.
 *
 * `CompositeAuth` accepts EITHER credential:
 *  1. **Supabase user token** (`MastraAuthSupabase`) — the access token from signup/login.
 *     Tenant rides in `app_metadata.tenant_id`; role/tool-scope is resolved separately.
 *  2. **Static service JWT** (`MastraJwtAuth`, `OPENAPI_JWT_SECRET`) — minted at
 *     `POST /svc/v1/auth/token` for backend / machine-to-machine callers (`sub = tenant`).
 *
 * Attached in production only; local dev omits it so the Studio playground loads
 * (see {@link isPlaygroundDevMode}).
 */
export function buildServerAuth(): CompositeAuth {
  const supabase = new MastraAuthSupabase({
    url: process.env.SUPABASE_URL,
    // Publishable key (sb_publishable_...) preferred; falls back to the legacy anon key.
    anonKey: getSupabasePublishableKey() ?? undefined,
    // MUST override: the default authorizeUser queries a `users.isAdmin` column we don't
    // have, which would 403 every real user. Allow any user mapped to a tenant.
    authorizeUser: (user) => Boolean(user?.app_metadata?.tenant_id),
  });
  const service = new MastraJwtAuth({
    secret: getOpenApiJwtSecret(),
    // Tighten the default lenient `!!user`. CompositeAuth.authorizeUser allows the request
    // if ANY provider authorizes; without this, the service provider would authorize Supabase
    // users too and bypass the Supabase tenant check. Our service tokens carry `sub` (tenant);
    // Supabase users have no `sub`, so they fall through to MastraAuthSupabase.authorizeUser.
    authorizeUser: (user) => Boolean((user as { sub?: string } | undefined)?.sub),
  });
  // Supabase first (user traffic); service JWT as fallback for machine callers.
  return new CompositeAuth([supabase, service] as unknown as MastraAuthProvider[]);
}
