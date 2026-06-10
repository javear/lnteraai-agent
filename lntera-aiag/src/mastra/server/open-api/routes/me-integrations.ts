import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import {
  deleteConnectionByShop,
  deleteConnectionsByTenant,
  listConnectionsByTenant,
} from '../../../integrations/shared/supabase';
import {
  deleteTenantIntegration,
  getTenantIntegration,
} from '../../../integrations/shared/tenant-integrations';
import { isPlatform, type Platform } from '../../../integrations/shared/types';
import { createState } from '../../../integrations/shared/oauth-state';
import { buildShopeeAuthUrl } from '../../../integrations/shopee/auth';
import { buildTiktokAuthUrl } from '../../../integrations/tiktok/auth';
import { buildDiscordInstallUrl } from '../../../integrations/discord/oauth-install';
import { connectTenantGroq, disconnectTenantGroq } from '../../../integrations/portkey/connect-tenant-groq';
import {
  connectTenantProvider,
  disconnectTenantProvider,
} from '../../../integrations/portkey/connect-tenant-provider';
import { resolveTenantProviderConfig } from '../../../integrations/portkey/resolve-tenant-model';
import { isValidGroqApiKey } from '../../../integrations/portkey/slugs';
import { getLlmProvider, isLlmProviderCode } from '../../../models/llm-providers';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/** Context with the bits we need beyond OpenApiHandlerContext (path param). */
type MeContext = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token | service JWT>' },
};

function buildConnectUrl(platform: OAuthPlatform, tenantId: string): string {
  const state = createState({ platform, tenantId });
  if (platform === 'shopee') return buildShopeeAuthUrl(state);
  if (platform === 'tiktok') return buildTiktokAuthUrl(state);
  return buildDiscordInstallUrl(state);
}

type OAuthPlatform = Platform | 'discord';
function isOAuthPlatform(value: string): value is OAuthPlatform {
  return value === 'discord' || isPlatform(value);
}

/** GET /svc/v1/me/integrations — unified connection status for the authenticated tenant. */
export const meIntegrationsStatusRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/integrations`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Unified integration status for the current tenant',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Status of all integrations' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const { tenantId } = auth;

    const [discordRow, groqConfig, geminiConfig, shopeeConns, tiktokConns] = await Promise.all([
      getTenantIntegration(tenantId, 'discord').catch(() => null),
      resolveTenantProviderConfig(tenantId, 'groq').catch(() => null),
      resolveTenantProviderConfig(tenantId, 'gemini').catch(() => null),
      listConnectionsByTenant(tenantId, ['shopee']).catch(() => []),
      listConnectionsByTenant(tenantId, ['tiktok']).catch(() => []),
    ]);

    const discordCfg = (discordRow?.config ?? {}) as {
      guildId?: string;
      channelId?: string;
      enabled?: boolean;
    };

    return c.json({
      discord: {
        connected: Boolean(discordRow && discordCfg.enabled !== false && discordCfg.guildId),
        guildId: discordCfg.guildId ?? null,
        channelId: discordCfg.channelId ?? null,
      },
      groq: {
        status: groqConfig?.status ?? 'not_connected',
        connectedAt: groqConfig?.connectedAt ?? null,
      },
      gemini: {
        status: geminiConfig?.status ?? 'not_connected',
        connectedAt: geminiConfig?.connectedAt ?? null,
      },
      shopee: shopeeConns.map((c2) => ({ shopId: c2.external_shop_id, shopName: c2.shop_name })),
      tiktok: tiktokConns.map((c2) => ({
        openId: c2.external_shop_id,
        shopName: c2.shop_name,
        region: c2.region,
      })),
    });
  },
});

/** POST /svc/v1/me/integrations/:platform/connect-url — OAuth authorize URL bound to the token's tenant. */
export const meConnectUrlRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/integrations/:platform/connect-url`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Get a tenant-bound OAuth connect URL (discord | shopee | tiktok)',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ url }' }, 400: { description: 'Unsupported platform' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: MeContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const platform = c.req.param('platform') ?? '';
    if (!isOAuthPlatform(platform)) {
      return openApiJsonError(c, 400, 'unsupported_platform', `Unsupported platform: ${platform}`);
    }

    try {
      const url = buildConnectUrl(platform, auth.tenantId);
      return c.json({ url });
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'connect_url_failed',
        err instanceof Error ? err.message : 'Could not build connect URL.',
      );
    }
  },
});

const groqConnectBody = z.object({ groqApiKey: z.string().min(1) }).strict();

/** POST /svc/v1/me/integrations/groq — connect a Groq key for the current tenant. */
export const meGroqConnectRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/integrations/groq`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Connect a Groq API key for the current tenant',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Connected' }, 400: { description: 'Invalid key' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return openApiJsonError(c, 400, 'invalid_request', 'Expected JSON body.');
    }
    let body;
    try {
      body = groqConnectBody.parse(raw);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }
    if (!isValidGroqApiKey(body.groqApiKey)) {
      return openApiJsonError(c, 400, 'invalid_key', 'Groq API key must start with gsk_.');
    }

    try {
      const config = await connectTenantGroq({ tenantId: auth.tenantId, groqApiKey: body.groqApiKey });
      return c.json({ integration_code: 'groq', config });
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

const llmConnectBody = z.object({ apiKey: z.string().min(1) }).strict();

/** POST /svc/v1/me/integrations/llm/:provider — connect a BYO LLM provider key (groq | gemini | …). */
export const meLlmConnectRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/integrations/llm/:provider`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Connect a BYO LLM provider API key (groq | gemini) for the current tenant',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Connected' }, 400: { description: 'Invalid key/provider' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: MeContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const provider = c.req.param('provider') ?? '';
    if (!isLlmProviderCode(provider)) {
      return openApiJsonError(c, 400, 'unsupported_provider', `Unsupported LLM provider: ${provider}`);
    }
    const def = getLlmProvider(provider)!;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return openApiJsonError(c, 400, 'invalid_request', 'Expected JSON body.');
    }
    let body;
    try {
      body = llmConnectBody.parse(raw);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }
    if (!def.validateKey(body.apiKey)) {
      return openApiJsonError(c, 400, 'invalid_key', `${def.displayName} API key must look like ${def.keyHint}.`);
    }

    try {
      const config = await connectTenantProvider({ tenantId: auth.tenantId, code: provider, apiKey: body.apiKey });
      return c.json({ integration_code: provider, config });
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'provision_failed',
        err instanceof Error ? err.message : `Failed to connect ${def.displayName}.`,
      );
    }
  },
});

/** DELETE /svc/v1/me/integrations/:integration — disconnect (discord | groq | gemini | shopee | tiktok). */
export const meDisconnectRoute = registerApiRoute(`${OPEN_API_PREFIX}/me/integrations/:integration`, {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Disconnect an integration for the current tenant',
    tags: [...OPENAPI_TAGS.integrations],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Disconnected' }, 400: { description: 'Unsupported' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: MeContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const { tenantId } = auth;
    const integration = c.req.param('integration') ?? '';

    try {
      if (integration === 'groq') {
        await disconnectTenantGroq(tenantId);
        return c.json({ ok: true, integration });
      }
      if (isLlmProviderCode(integration)) {
        await disconnectTenantProvider({ tenantId, code: integration });
        return c.json({ ok: true, integration });
      }
      if (integration === 'discord') {
        await deleteTenantIntegration(tenantId, 'discord');
        return c.json({ ok: true, integration });
      }
      if (isPlatform(integration)) {
        const removed = await deleteConnectionsByTenant(tenantId, integration);
        return c.json({ ok: true, integration, removed });
      }
      return openApiJsonError(c, 400, 'unsupported', `Unsupported integration: ${integration}`);
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'disconnect_failed',
        err instanceof Error ? err.message : 'Failed to disconnect.',
      );
    }
  },
});

/** DELETE /svc/v1/me/integrations/:platform/:shopId — disconnect ONE marketplace store (shopee | tiktok). */
export const meDisconnectStoreRoute = registerApiRoute(
  `${OPEN_API_PREFIX}/me/integrations/:platform/:shopId`,
  {
    method: 'DELETE',
    requiresAuth: false,
    openapi: {
      summary: 'Disconnect a single marketplace store for the current tenant',
      tags: [...OPENAPI_TAGS.integrations],
      parameters: [authHeaderParam],
      responses: { 200: { description: 'Disconnected' }, 400: { description: 'Unsupported platform' }, 401: { description: 'Unauthorized' } },
    },
    handler: async (c: MeContext) => {
      const auth = await resolveTenantFromBearer(c);
      if (auth instanceof Response) return auth;

      const platform = c.req.param('platform') ?? '';
      const shopId = c.req.param('shopId') ?? '';
      if (!isPlatform(platform)) {
        return openApiJsonError(c, 400, 'unsupported_platform', `Unsupported platform: ${platform}`);
      }
      if (!shopId) {
        return openApiJsonError(c, 400, 'missing_shop', 'A store id is required.');
      }
      try {
        const removed = await deleteConnectionByShop(auth.tenantId, platform, shopId);
        return c.json({ ok: true, platform, shopId, removed });
      } catch (err) {
        return openApiJsonError(
          c,
          400,
          'disconnect_failed',
          err instanceof Error ? err.message : 'Failed to disconnect store.',
        );
      }
    },
  },
);

export const meIntegrationsRoutes = [
  meIntegrationsStatusRoute,
  meConnectUrlRoute,
  meGroqConnectRoute,
  meLlmConnectRoute,
  meDisconnectStoreRoute,
  meDisconnectRoute,
];
