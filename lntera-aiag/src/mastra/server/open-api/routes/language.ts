// REST for the per-tenant language preference (UI + assistant). GET the current language + the supported
// set; PUT to change it. Same bearer auth as the other /svc/v1 routes.
import { registerApiRoute } from '@mastra/core/server';
import {
  SUPPORTED_LANGUAGES,
  getTenantLanguage,
  normalizeLanguage,
  setTenantLanguage,
} from '../../../integrations/shared/language-prefs';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const getLanguageRoute = registerApiRoute(`${OPEN_API_PREFIX}/preferences/language`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get the tenant language preference + supported languages',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const language = await getTenantLanguage(auth.tenantId);
    return c.json({ language, supported: SUPPORTED_LANGUAGES });
  },
});

const putLanguageRoute = registerApiRoute(`${OPEN_API_PREFIX}/preferences/language`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Set the tenant language preference',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Saved' }, 400: { description: 'Unsupported language' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => ({}))) as { language?: unknown };
    const language = normalizeLanguage(body.language);
    if (!language) return c.json({ error: 'Unsupported language' }, 400);
    await setTenantLanguage(auth.tenantId, language);
    return c.json({ language, supported: SUPPORTED_LANGUAGES });
  },
});

export const languageRoutes = [getLanguageRoute, putLanguageRoute];
