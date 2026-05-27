import { registerApiRoute } from '@mastra/core/server';
import {
  buildDiscordInstallUrl,
  exchangeDiscordOAuthCode,
  getDiscordOauthConfig,
  resolveDefaultChannelId,
} from '../integrations/discord/oauth-install';
import { createState, verifyState } from '../integrations/shared/oauth-state';
import { findDiscordIntegrationConflictForRouting, upsertTenantIntegration } from '../integrations/shared/tenant-integrations';
import { patchConnectionProfile, resolveTenantId, upsertConnection } from '../integrations/shared/supabase';
import { isPlatform, type Platform } from '../integrations/shared/types';
import { buildShopeeAuthUrl, exchangeShopeeCode } from '../integrations/shopee/auth';
import { getShopeeClient } from '../integrations/shopee/client';
import { getShopeeConfig } from '../integrations/shopee/config';
import { getShopeeShopInfo } from '../integrations/shopee/shop-info';
import { buildTiktokAuthUrl, exchangeTiktokCode, getTiktokAuthorizedShops } from '../integrations/tiktok/auth';

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 24px;color:#222}
h1{margin-bottom:8px}
code{background:#f3f3f3;padding:2px 6px;border-radius:4px}
.ok{color:#0a7a2f}.err{color:#b00020}
</style></head><body>${body}</body></html>`;
}

export const oauthRoutes = [
  // Discord routes must be registered before `/oauth/:platform/start`, otherwise `discord` is
  // captured as `:platform` and marketplace handler returns "Unsupported platform: discord".
  registerApiRoute('/oauth/discord/start', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Start Discord bot OAuth install (tenant must exist in tenant_master)',
      tags: ['OAuth'],
      parameters: [
        { name: 'tenantId', in: 'query', required: true, schema: { type: 'string', description: 'Tenant UUID or slug' } },
      ],
      responses: { 302: { description: 'Redirect to Discord authorize' }, 400: { description: 'Unknown tenant or missing config' } },
    },
    handler: async (c) => {
      const tenantInput = c.req.query('tenantId');
      if (!tenantInput) {
        return c.html(
          htmlPage('Discord install', '<h1 class="err">Missing tenantId.</h1><p>Pass <code>?tenantId=&lt;slug-or-uuid&gt;</code></p>'),
          400,
        );
      }
      let tenantId: string;
      try {
        tenantId = await resolveTenantId(tenantInput);
      } catch (err) {
        return c.html(
          htmlPage(
            'Discord install',
            `<h1 class="err">Unknown tenant.</h1><p>${(err as Error).message}</p><p>Create the tenant in <code>tenant_master</code> first.</p>`,
          ),
          400,
        );
      }
      try {
        getDiscordOauthConfig();
      } catch (err) {
        return c.html(
          htmlPage(
            'Discord install',
            `<h1 class="err">Server configuration</h1><p>${(err as Error).message}</p>`,
          ),
          500,
        );
      }
      const state = createState({ platform: 'discord', tenantId });
      return c.redirect(buildDiscordInstallUrl(state), 302);
    },
  }),

  registerApiRoute('/oauth/discord/callback', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Discord bot OAuth callback — upserts tenant_integrations for discord',
      tags: ['OAuth'],
      parameters: [
        { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'guild_id', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Install completed or error HTML' } },
    },
    handler: async (c) => {
      const oauthErr = c.req.query('error');
      const oauthDesc = c.req.query('error_description');
      if (oauthErr) {
        return c.html(
          htmlPage(
            'Discord install cancelled',
            `<h1 class="err">Discord OAuth: ${oauthErr}</h1><p>${oauthDesc ?? ''}</p>`,
          ),
          400,
        );
      }

      const code = c.req.query('code');
      const stateRaw = c.req.query('state');
      const guildIdRaw = c.req.query('guild_id');
      if (!code || !stateRaw) {
        return c.html(
          htmlPage('Discord OAuth error', '<h1 class="err">Missing code or state.</h1>'),
          400,
        );
      }

      let tenantId: string | null = null;
      try {
        const state = verifyState(stateRaw);
        if (state.platform !== 'discord') throw new Error('State platform mismatch.');
        tenantId = state.tenantId ?? null;
      } catch (err) {
        return c.html(
          htmlPage('Discord OAuth error', `<h1 class="err">Invalid state.</h1><p>${(err as Error).message}</p>`),
          400,
        );
      }
      if (!tenantId) {
        return c.html(
          htmlPage(
            'Discord OAuth error',
            '<h1 class="err">Missing tenant in state.</h1><p>Start from <code>/oauth/discord/start?tenantId=...</code></p>',
          ),
          400,
        );
      }

      try {
        await resolveTenantId(tenantId);
      } catch (err) {
        return c.html(
          htmlPage('Discord OAuth error', `<h1 class="err">Tenant no longer valid.</h1><p>${(err as Error).message}</p>`),
          400,
        );
      }

      if (!guildIdRaw?.trim()) {
        return c.html(
          htmlPage(
            'Discord OAuth error',
            '<h1 class="err">Missing guild_id.</h1><p>Authorize the bot for a server (install scope).</p>',
          ),
          400,
        );
      }
      const guildId = guildIdRaw.trim();

      try {
        await exchangeDiscordOAuthCode(code);
      } catch (err) {
        return c.html(
          htmlPage('Discord OAuth failed', `<h1 class="err">Token exchange failed</h1><p>${(err as Error).message}</p>`),
          500,
        );
      }

      let channelId: string;
      try {
        channelId = await resolveDefaultChannelId(guildId);
      } catch (err) {
        return c.html(
          htmlPage('Discord install', `<h1 class="err">Could not pick a channel</h1><p>${(err as Error).message}</p>`),
          500,
        );
      }

      const conflict = await findDiscordIntegrationConflictForRouting({
        guildId,
        channelId,
        excludeTenantId: tenantId,
      });
      if (conflict) {
        return c.html(
          htmlPage(
            'Discord install conflict',
            `<h1 class="err">This guild/channel is already linked to another tenant.</h1><p>Tenant: <code>${conflict.tenant_id}</code></p>`,
          ),
          409,
        );
      }

      const termsVersion = process.env.DISCORD_TERMS_VERSION?.trim();
      const nowIso = new Date().toISOString();
      const config: Record<string, unknown> = {
        guildId,
        channelId,
        dataProcessingAcknowledgedAt: nowIso,
        enabled: true,
      };
      if (termsVersion) {
        config.termsAcknowledgedVersion = termsVersion;
      }

      try {
        await upsertTenantIntegration({
          tenant_id: tenantId,
          integration_code: 'discord',
          config,
        });
      } catch (err) {
        return c.html(
          htmlPage('Discord install failed', `<h1 class="err">Save failed</h1><p>${(err as Error).message}</p>`),
          500,
        );
      }

      return c.html(
        htmlPage(
          'Discord connected',
          `<h1 class="ok">Discord bot installed</h1>
           <p>Guild: <code>${guildId}</code></p>
           <p>Channel: <code>${channelId}</code></p>
           <p>Consent recorded at <code>${nowIso}</code>.</p>
           <p>You can close this tab.</p>`,
        ),
      );
    },
  }),

  registerApiRoute('/oauth/:platform/start', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Start OAuth flow for a marketplace',
      tags: ['OAuth'],
      parameters: [
        { name: 'platform', in: 'path', required: true, schema: { type: 'string', enum: ['shopee', 'tiktok'] } },
        { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { 302: { description: 'Redirect to platform authorization page' } },
    },
    handler: async c => {
      const platformParam = c.req.param('platform');
      if (!isPlatform(platformParam)) {
        return c.text(`Unsupported platform: ${platformParam}`, 400);
      }
      const platform: Platform = platformParam;
      const tenantInput = c.req.query('tenantId');
      if (!tenantInput) {
        return c.text('Missing tenantId. Pass a tenant slug or tenant UUID.', 400);
      }
      const tenantId = await resolveTenantId(tenantInput);
      const state = createState({ platform, tenantId });

      const target = platform === 'shopee' ? buildShopeeAuthUrl(state) : buildTiktokAuthUrl(state);
      return c.redirect(target, 302);
    },
  }),

  registerApiRoute('/oauth/shopee/callback', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Shopee OAuth callback',
      tags: ['OAuth'],
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'shop_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'tenantId', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'OAuth completed' } },
    },
    handler: async c => {
      const code = c.req.query('code');
      const shopIdRaw = c.req.query('shop_id');
      const stateRaw = c.req.query('state');
      if (!code || !shopIdRaw) {
        return c.html(
          htmlPage('Shopee OAuth error', '<h1 class="err">Missing code or shop_id.</h1>'),
          400,
        );
      }

      let tenantId: string | null = null;
      if (stateRaw) {
        try {
          const state = verifyState(stateRaw);
          if (state.platform !== 'shopee') throw new Error('State platform mismatch.');
          tenantId = state.tenantId ?? null;
        } catch (err) {
          return c.html(
            htmlPage('Shopee OAuth error', `<h1 class="err">Invalid state.</h1><p>${(err as Error).message}</p>`),
            400,
          );
        }
      }
      if (!tenantId) {
        const fallbackTenant = c.req.query('tenantId');
        if (fallbackTenant) {
          try {
            tenantId = await resolveTenantId(fallbackTenant);
          } catch (err) {
            return c.html(
              htmlPage(
                'Shopee OAuth error',
                `<h1 class="err">Invalid tenantId.</h1><p>${(err as Error).message}</p>`,
              ),
              400,
            );
          }
        }
      }
      if (!tenantId) {
        return c.html(
          htmlPage(
            'Shopee OAuth error',
            '<h1 class="err">Missing tenant context.</h1><p>Pass tenantId on /oauth/:platform/start, or include tenantId in callback query.</p>',
          ),
          400,
        );
      }

      const shopId = Number(shopIdRaw);
      try {
        const tokens = await exchangeShopeeCode({ code, shopId });
        const cfg = getShopeeConfig();
        await upsertConnection({
          platform: 'shopee',
          external_shop_id: String(shopId),
          region: cfg.region,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          access_token_expires_at: new Date(Date.now() + tokens.expire_in * 1000),
          tenant_id: tenantId,
          raw_metadata: {
            shop_id_list: tokens.shop_id_list ?? null,
            merchant_id_list: tokens.merchant_id_list ?? null,
          },
        });
        try {
          const client = await getShopeeClient(String(shopId));
          const info = await getShopeeShopInfo(client);
          await patchConnectionProfile('shopee', String(shopId), {
            shop_name: info.shopName,
            region: info.region ?? cfg.region,
          });
        } catch {
          // Shop still connected; list-marketplace-shops will retry get_shop_info when name is missing.
        }
        return c.html(
          htmlPage(
            'Shopee connected',
            `<h1 class="ok">Shopee shop connected</h1><p>Shop ID: <code>${shopId}</code></p><p>You can close this tab.</p>`,
          ),
        );
      } catch (err) {
        return c.html(
          htmlPage('Shopee OAuth failed', `<h1 class="err">Token exchange failed</h1><p>${(err as Error).message}</p>`),
          500,
        );
      }
    },
  }),

  registerApiRoute('/oauth/tiktok/callback', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'TikTok Shop OAuth callback',
      tags: ['OAuth'],
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'OAuth completed' } },
    },
    handler: async (c) => {
      const code = c.req.query('code');
      const stateRaw = c.req.query('state');
      if (!code || !stateRaw) {
        return c.html(
          htmlPage('TikTok OAuth error', '<h1 class="err">Missing code or state.</h1>'),
          400,
        );
      }

      let tenantId: string | null = null;
      try {
        const state = verifyState(stateRaw);
        if (state.platform !== 'tiktok') throw new Error('State platform mismatch.');
        tenantId = state.tenantId ?? null;
      } catch (err) {
        return c.html(
          htmlPage('TikTok OAuth error', `<h1 class="err">Invalid state.</h1><p>${(err as Error).message}</p>`),
          400,
        );
      }
      if (!tenantId) {
        return c.html(
          htmlPage(
            'TikTok OAuth error',
            '<h1 class="err">Missing tenant context in state.</h1><p>Start auth with /oauth/tiktok/start?tenantId=&lt;slug-or-uuid&gt;.</p>',
          ),
          400,
        );
      }

      try {
        const tokens = await exchangeTiktokCode(code);
        let shops: Array<{ id?: string; cipher?: string; name?: string; region?: string }> = [];
        let shopCipher: string | null = null;
        let shopsFetchError: string | null = null;
        try {
          shops = await getTiktokAuthorizedShops(tokens.access_token);
          shopCipher = shops.find(s => typeof s.cipher === 'string' && s.cipher.trim())?.cipher?.trim() ?? null;
        } catch (err) {
          // Non-fatal for connection bootstrap; product APIs will require cipher later.
          shopsFetchError = (err as Error).message;
        }

        // TikTok returns `open_id` (seller's open id) not a shop_id directly.
        // We use `open_id` as `external_shop_id` so subsequent calls can resolve
        // shops via the Authorization API and store `shop_cipher` in raw_metadata.
        const externalShopId = tokens.open_id ?? `tiktok-${Date.now()}`;
        await upsertConnection({
          platform: 'tiktok',
          external_shop_id: externalShopId,
          shop_name: tokens.seller_name ?? null,
          region: tokens.seller_base_region ?? null,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          access_token_expires_at: new Date(Date.now() + tokens.access_token_expire_in * 1000),
          refresh_token_expires_at: new Date(Date.now() + tokens.refresh_token_expire_in * 1000),
          scope: tokens.granted_scopes?.join(',') ?? null,
          shop_cipher: shopCipher,
          tenant_id: tenantId,
          raw_metadata: {
            open_id: tokens.open_id ?? null,
            granted_scopes: tokens.granted_scopes ?? null,
            shops,
            shop_cipher: shopCipher,
            shops_fetch_error: shopsFetchError,
          },
        });
        return c.html(
          htmlPage(
            'TikTok connected',
            `<h1 class="ok">TikTok seller connected</h1>
             <p>Open ID: <code>${externalShopId}</code></p>
             <p>Shop cipher: <code>${shopCipher ?? 'not available (missing scope)'}</code></p>
             <p>You can close this tab.</p>`,
          ),
        );
      } catch (err) {
        return c.html(
          htmlPage('TikTok OAuth failed', `<h1 class="err">Token exchange failed</h1><p>${(err as Error).message}</p>`),
          500,
        );
      }
    },
  }),
];
