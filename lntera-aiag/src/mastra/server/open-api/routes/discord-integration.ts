import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import {
  findDiscordIntegrationConflictForRouting,
  upsertTenantIntegration,
} from '../../../integrations/shared/tenant-integrations';
import { discordTenantIntegrationConfigSchema } from '../../../integrations/shared/types';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, requireTenantJwt, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

export const discordIntegrationRoute = registerApiRoute(`${OPEN_API_PREFIX}/integrations/discord`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Register or update Discord integration config for the tenant in the JWT',
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
            description:
              'Discord linkage + consent: guildId, channelId, dataProcessingAcknowledgedAt when enabled; optional termsAcknowledgedVersion',
          },
        },
      },
    },
    responses: {
      200: { description: 'Upserted integration row' },
      401: { description: 'Missing or invalid JWT' },
      400: { description: 'Invalid body' },
      409: { description: 'guildId/channelId already linked to another tenant' },
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

    let config;
    try {
      config = discordTenantIntegrationConfigSchema.parse(raw);
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
          : String(err);
      return openApiJsonError(c, 400, 'invalid_config', msg);
    }

    if (config.enabled !== false && config.guildId && config.channelId) {
      const conflict = await findDiscordIntegrationConflictForRouting({
        guildId: config.guildId,
        channelId: config.channelId,
        excludeTenantId: auth.tenantId,
      });
      if (conflict) {
        return openApiJsonError(
          c,
          409,
          'routing_conflict',
          `Discord guild/channel is already linked to tenant ${conflict.tenant_id}.`,
        );
      }
    }

    try {
      const row = await upsertTenantIntegration({
        tenant_id: auth.tenantId,
        integration_code: 'discord',
        config: { ...config } as Record<string, unknown>,
      });
      return c.json(
        {
          id: row.id,
          tenant_id: row.tenant_id,
          integration_code: row.integration_code,
          config: row.config,
          updated_at: row.updated_at,
        },
        200,
      );
    } catch (err) {
      return openApiJsonError(
        c,
        500,
        'upsert_failed',
        err instanceof Error ? err.message : 'Failed to save integration.',
      );
    }
  },
});
