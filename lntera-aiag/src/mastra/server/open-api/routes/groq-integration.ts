import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { connectTenantGroq, disconnectTenantGroq } from '../../../integrations/portkey/connect-tenant-groq';
import { isValidGroqApiKey } from '../../../integrations/portkey/slugs';
import { resolveTenantGroqConfig } from '../../../integrations/portkey/resolve-tenant-model';
import { groqTenantIntegrationConfigSchema } from '../../../integrations/shared/types';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, requireTenantJwt, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

const groqPutBodySchema = z
  .object({
    groqApiKey: z.string().min(1),
    skipValidation: z.boolean().optional(),
  })
  .strict();

export const groqIntegrationRoute = registerApiRoute(`${OPEN_API_PREFIX}/integrations/groq`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Connect tenant Groq API key via Portkey Model Catalog',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [
      {
        name: 'Authorization',
        in: 'header',
        required: true,
        schema: { type: 'string', description: 'Bearer access_token' },
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { groqApiKey: { type: 'string' }, skipValidation: { type: 'boolean' } },
            required: ['groqApiKey'],
          },
        },
      },
    },
    responses: {
      200: { description: 'Upserted groq integration row' },
      401: { description: 'Missing or invalid JWT' },
      400: { description: 'Invalid body or key' },
    },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await requireTenantJwt(c);
    if (auth instanceof Response) return auth;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return openApiJsonError(c, 400, 'invalid_request', 'Expected JSON body.');
    }

    let body;
    try {
      body = groqPutBodySchema.parse(raw);
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : String(err);
      return openApiJsonError(c, 400, 'invalid_config', msg);
    }

    if (!isValidGroqApiKey(body.groqApiKey)) {
      return openApiJsonError(c, 400, 'invalid_key', 'Groq API key must start with gsk_.');
    }

    try {
      const config = await connectTenantGroq({
        tenantId: auth.tenantId,
        groqApiKey: body.groqApiKey,
        skipValidation: body.skipValidation,
      });
      return c.json(
        {
          tenant_id: auth.tenantId,
          integration_code: 'groq',
          config,
        },
        200,
      );
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'provision_failed',
        err instanceof Error ? err.message : 'Failed to connect Groq.',
      );
    }
  },
});

export const groqIntegrationGetRoute = registerApiRoute(`${OPEN_API_PREFIX}/integrations/groq`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get tenant Groq integration status (no secrets)',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [
      {
        name: 'Authorization',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: { 200: { description: 'Integration config' }, 404: { description: 'Not configured' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await requireTenantJwt(c);
    if (auth instanceof Response) return auth;

    const config = await resolveTenantGroqConfig(auth.tenantId);
    if (!config) {
      return openApiJsonError(c, 404, 'not_found', 'Groq integration not configured.');
    }

    return c.json(
      {
        tenant_id: auth.tenantId,
        integration_code: 'groq',
        config: groqTenantIntegrationConfigSchema.parse(config),
      },
      200,
    );
  },
});

export const groqIntegrationDeleteRoute = registerApiRoute(`${OPEN_API_PREFIX}/integrations/groq`, {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Revoke tenant Groq integration and Portkey provider',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [
      {
        name: 'Authorization',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: { 200: { description: 'Revoked' }, 404: { description: 'Not found' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await requireTenantJwt(c);
    if (auth instanceof Response) return auth;

    try {
      const config = await disconnectTenantGroq(auth.tenantId);
      return c.json(
        {
          tenant_id: auth.tenantId,
          integration_code: 'groq',
          config,
        },
        200,
      );
    } catch (err) {
      return openApiJsonError(
        c,
        404,
        'not_found',
        err instanceof Error ? err.message : 'Groq integration not found.',
      );
    }
  },
});
