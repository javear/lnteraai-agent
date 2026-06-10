import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { getTenantById, resolveTenantId } from '../../../integrations/shared/supabase';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { signOpenApiAccessToken } from '../jwt';
import { constantTimeEqualString } from '../lib/service-key';
import { openApiJsonError, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

const bodySchema = z.object({
  tenantId: z.string().min(1),
  /** Requested lifetime in seconds; server clamps to 1 .. OPENAPI_JWT_TTL_SECONDS (or default 900). */
  ttl_seconds: z.coerce.number().int().positive().optional(),
});

export const authTokenRoute = registerApiRoute(`${OPEN_API_PREFIX}/auth/token`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Mint a short-lived JWT for tenant-scoped Open API calls',
    tags: [...OPENAPI_TAGS.auth],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['tenantId'],
            properties: {
              tenantId: { type: 'string', description: 'Tenant UUID or slug' },
              ttl_seconds: {
                type: 'integer',
                description:
                  'Optional access token lifetime in seconds (clamped to server max OPENAPI_JWT_TTL_SECONDS or 900)',
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Access token' },
      401: { description: 'Invalid service key' },
      503: { description: 'Service not configured' },
    },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const expected = process.env.OPENAPI_SERVICE_API_KEY?.trim();
    if (!expected) {
      return openApiJsonError(
        c,
        503,
        'service_unavailable',
        'OPENAPI_SERVICE_API_KEY is not configured.',
      );
    }

    const got = c.req.header('x-service-api-key')?.trim();
    if (!got || !constantTimeEqualString(expected, got)) {
      return openApiJsonError(c, 401, 'unauthorized', 'Invalid or missing X-Service-Api-Key.');
    }

    let body: z.infer<typeof bodySchema>;
    try {
      const raw = await c.req.json();
      body = bodySchema.parse(raw);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.message : 'Invalid JSON body.';
      return openApiJsonError(c, 400, 'invalid_request', msg);
    }

    let tenantId: string;
    try {
      tenantId = await resolveTenantId(body.tenantId);
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'invalid_tenant',
        err instanceof Error ? err.message : 'Unknown tenant.',
      );
    }

    let tenantSlug: string | null = null;
    try {
      const tm = await getTenantById(tenantId);
      tenantSlug = tm?.slug ?? null;
    } catch {
      /* non-fatal */
    }

    try {
      const { token, expiresIn } = await signOpenApiAccessToken({
        tenantId,
        tenantSlug,
        ttlSeconds: body.ttl_seconds,
      });
      return c.json(
        {
          access_token: token,
          token_type: 'Bearer',
          expires_in: expiresIn,
        },
        200,
      );
    } catch (err) {
      return openApiJsonError(
        c,
        503,
        'service_unavailable',
        err instanceof Error ? err.message : 'JWT signing failed.',
      );
    }
  },
});
