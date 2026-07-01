import { registerApiRoute } from '@mastra/core/server';
import { resolveActiveTenantProviders } from '../../../integrations/portkey/resolve-tenant-model';
import { providerAllowedSegments } from '../../../models/llm-model-chain';
import { getLlmProvider, llmModelLabel, toModelCode } from '../../../models/llm-providers';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token | service JWT>' },
};

export type PinnableModel = {
  modelCode: string;
  segment: string;
  providerCode: string;
  providerName: string;
  tier: 'free' | 'advanced';
  label: string;
};

/**
 * GET /svc/v1/me/models — the models the tenant can pin in the chat box. One entry per allowed
 * model across active providers (free → curated toolModels, advanced → user-selected models).
 * The UI prepends an "Auto" option (unpinned = the default free round-robin).
 */
export const meModelsRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/models`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'List the models the current tenant can pin in chat',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ models: PinnableModel[] }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const providers = await resolveActiveTenantProviders(auth.tenantId).catch(() => []);
    const models: PinnableModel[] = [];
    for (const p of providers) {
      const def = getLlmProvider(p.code);
      if (!def) continue;
      for (const segment of providerAllowedSegments(p)) {
        const modelCode = toModelCode(p.code, segment);
        models.push({
          modelCode,
          segment,
          providerCode: p.code,
          providerName: def.displayName,
          tier: def.tier,
          label: llmModelLabel(modelCode),
        });
      }
    }

    return c.json({ models });
  },
});

export const meModelsRoutes = [meModelsRoute];
