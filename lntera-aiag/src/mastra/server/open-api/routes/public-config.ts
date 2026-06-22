import { registerApiRoute } from '@mastra/core/server';
import { getSupabasePublishableKey } from '../../../integrations/shared/supabase';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/**
 * Public runtime config for the web app — lets the SPA build its Supabase client from a
 * single server-side source (no VITE_ secrets baked at build time, no rebuild on key change).
 * Returns only browser-safe values (publishable key).
 */
export const publicConfigRoute = registerApiRoute(`${OPEN_API_PREFIX}/public-config`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Public runtime config for the web app (Supabase URL + publishable key)',
    tags: [...OPENAPI_TAGS.root],
    responses: { 200: { description: 'Config JSON' }, 503: { description: 'Supabase not configured' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const supabaseKey = getSupabasePublishableKey();
    if (!supabaseUrl || !supabaseKey) {
      return openApiJsonError(c, 503, 'not_configured', 'Supabase is not configured on the server.');
    }
    // Browser-safe OneSignal ids (the REST key stays server-only). Null when push is unconfigured.
    const oneSignalAppId = process.env.ONESIGNAL_APP_ID?.trim() || null;
    const oneSignalSafariWebId = process.env.ONESIGNAL_SAFARI_WEB_ID?.trim() || null;
    // Google Web OAuth client id for One Tap (browser-safe — it's a public client id). Null disables
    // One Tap. Must match a client id in Supabase → Auth → Google → "Authorized Client IDs".
    const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
    return c.json({ supabaseUrl, supabaseKey, oneSignalAppId, oneSignalSafariWebId, googleClientId });
  },
});
