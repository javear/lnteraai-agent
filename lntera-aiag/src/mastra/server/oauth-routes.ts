import { registerApiRoute } from '@mastra/core/server';
import {
  buildDiscordInstallUrl,
  exchangeDiscordOAuthCode,
  getDiscordOauthConfig,
  resolveDefaultChannelId,
} from '../integrations/discord/oauth-install';
import {
  clearOAuthStateCookie,
  createState,
  readOAuthStateCookie,
  setOAuthStateCookie,
  verifyState,
} from '../integrations/shared/oauth-state';
import { findDiscordIntegrationConflictForRouting, upsertTenantIntegration } from '../integrations/shared/tenant-integrations';
import { patchConnectionProfile, resolveTenantId, upsertConnection } from '../integrations/shared/supabase';
import { isPlatform, type Platform } from '../integrations/shared/types';
import { webAppUrl } from './web-app-origin';
import { buildShopeeAuthUrl, exchangeShopeeCode } from '../integrations/shopee/auth';
import { getShopeeClient } from '../integrations/shopee/client';
import { getShopeeConfig } from '../integrations/shopee/config';
import { getShopeeShopInfo } from '../integrations/shopee/shop-info';
import { buildTiktokAuthUrl, exchangeTiktokCode, getTiktokAuthorizedShops } from '../integrations/tiktok/auth';
import { notifyTenantOfConnectionEvent } from '../active-mode/notifier';
import { notifyConnectedOfferSync } from '../sync/product-sync-notifier';
import { oauthErrorPage } from './html-pages';

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
          oauthErrorPage({ platform: 'Discord', title: 'Missing tenantId', message: 'Pass ?tenantId=<slug-or-uuid> in the URL.' }),
          400,
        );
      }
      let tenantId: string;
      try {
        tenantId = await resolveTenantId(tenantInput);
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Unknown tenant', message: (err as Error).message, hint: 'Create the tenant in tenant_master first.' }),
          400,
        );
      }
      try {
        getDiscordOauthConfig();
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Server configuration error', message: (err as Error).message }),
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
          oauthErrorPage({ platform: 'Discord', title: `OAuth: ${oauthErr}`, message: oauthDesc ?? 'Authorization was cancelled or denied.' }),
          400,
        );
      }

      const code = c.req.query('code');
      const stateRaw = c.req.query('state');
      const guildIdRaw = c.req.query('guild_id');
      if (!code || !stateRaw) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Missing parameters', message: 'The authorization code or state parameter is missing.' }),
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
          oauthErrorPage({ platform: 'Discord', title: 'Invalid state', message: (err as Error).message }),
          400,
        );
      }
      if (!tenantId) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Missing tenant context', message: 'No tenant was found in the OAuth state.', hint: 'Start from /oauth/discord/start?tenantId=...' }),
          400,
        );
      }

      try {
        await resolveTenantId(tenantId);
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Tenant no longer valid', message: (err as Error).message }),
          400,
        );
      }

      if (!guildIdRaw?.trim()) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Missing server', message: 'No guild_id was returned. Authorize the bot for a server (install scope).' }),
          400,
        );
      }
      const guildId = guildIdRaw.trim();

      try {
        await exchangeDiscordOAuthCode(code);
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Token exchange failed', message: (err as Error).message }),
          500,
        );
      }

      let channelId: string;
      try {
        channelId = await resolveDefaultChannelId(guildId);
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Discord', title: 'Could not pick a channel', message: (err as Error).message }),
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
          oauthErrorPage({ platform: 'Discord', title: 'Server already linked', message: `This guild and channel are already linked to another workspace (${conflict.tenant_id}).` }),
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
          oauthErrorPage({ platform: 'Discord', title: 'Save failed', message: (err as Error).message }),
          500,
        );
      }

      return c.redirect(webAppUrl('/integrations?connected=discord&status=ok'), 302);
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

      // Preferred: a pre-signed state minted by the authenticated connect-url endpoint (keeps the
      // tenant binding tamper-proof). Legacy: a raw tenantId query (manual/direct starts).
      const presigned = c.req.query('st');
      let state: string;
      if (presigned) {
        try {
          const parsed = verifyState(presigned);
          if (parsed.platform !== platform) throw new Error('State platform mismatch.');
          state = presigned;
        } catch (err) {
          return c.text(`Invalid state: ${(err as Error).message}`, 400);
        }
      } else {
        const tenantInput = c.req.query('tenantId');
        if (!tenantInput) {
          return c.text('Missing tenantId. Pass a tenant slug or tenant UUID.', 400);
        }
        const tenantId = await resolveTenantId(tenantInput);
        state = createState({ platform, tenantId });
      }
      // Set the state cookie in THIS top-level navigation — first-party to the API origin, so it's
      // reliably stored and sent back on the provider's callback redirect (even when the SPA lives on
      // another origin, and even for Shopee which never echoes `state`).
      setOAuthStateCookie(c, state);

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
      // Shopee drops the `state` query param on the redirect — fall back to the signed state cookie.
      const stateRaw = c.req.query('state') ?? readOAuthStateCookie(c);
      if (!code || !shopIdRaw) {
        return c.html(
          oauthErrorPage({ platform: 'Shopee', title: 'Missing parameters', message: 'The authorization code or shop_id is missing.' }),
          400,
        );
      }

      let tenantId: string | null = null;
      if (stateRaw) {
        clearOAuthStateCookie(c); // single-use: consume the state cookie
        try {
          const state = verifyState(stateRaw);
          if (state.platform !== 'shopee') throw new Error('State platform mismatch.');
          tenantId = state.tenantId ?? null;
        } catch (err) {
          return c.html(
            oauthErrorPage({ platform: 'Shopee', title: 'Invalid state', message: (err as Error).message }),
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
              oauthErrorPage({ platform: 'Shopee', title: 'Invalid tenantId', message: (err as Error).message }),
              400,
            );
          }
        }
      }
      if (!tenantId) {
        return c.html(
          oauthErrorPage({ platform: 'Shopee', title: 'Missing tenant context', message: 'No tenant could be resolved from the request.', hint: 'Pass tenantId on /oauth/:platform/start, or include tenantId in the callback query.' }),
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
        let shopName: string | null = null;
        try {
          const client = await getShopeeClient(String(shopId));
          const info = await getShopeeShopInfo(client);
          shopName = info.shopName;
          await patchConnectionProfile('shopee', String(shopId), {
            shop_name: info.shopName,
            region: info.region ?? cfg.region,
          });
        } catch {
          // Shop still connected; list-marketplace-shops will retry get_shop_info when name is missing.
        }
        void notifyTenantOfConnectionEvent({ tenantId, integration: 'shopee', status: 'connected', shopName });
        // Deterministic (no-LLM) "import your products now?" offer with token-free action buttons.
        void notifyConnectedOfferSync(tenantId, 'shopee', shopName);
        return c.redirect(webAppUrl('/integrations?connected=shopee&status=ok'), 302);
      } catch (err) {
        void notifyTenantOfConnectionEvent({ tenantId, integration: 'shopee', status: 'failed', errorMessage: (err as Error).message });
        return c.redirect(
          webAppUrl(`/integrations?connected=shopee&status=error&message=${encodeURIComponent((err as Error).message)}`),
          302,
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
      // Fall back to the signed state cookie if the provider didn't echo `state` back.
      const stateRaw = c.req.query('state') ?? readOAuthStateCookie(c);
      if (!code || !stateRaw) {
        return c.html(
          oauthErrorPage({ platform: 'TikTok Shop', title: 'Missing parameters', message: 'The authorization code or state parameter is missing.' }),
          400,
        );
      }
      clearOAuthStateCookie(c); // single-use: consume the state cookie

      let tenantId: string | null = null;
      try {
        const state = verifyState(stateRaw);
        if (state.platform !== 'tiktok') throw new Error('State platform mismatch.');
        tenantId = state.tenantId ?? null;
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'TikTok Shop', title: 'Invalid state', message: (err as Error).message }),
          400,
        );
      }
      if (!tenantId) {
        return c.html(
          oauthErrorPage({ platform: 'TikTok Shop', title: 'Missing tenant context', message: 'No tenant was found in the OAuth state.', hint: 'Start auth with /oauth/tiktok/start?tenantId=<slug-or-uuid>.' }),
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
        void notifyTenantOfConnectionEvent({ tenantId, integration: 'tiktok', status: 'connected', shopName: tokens.seller_name ?? null });
        // Deterministic (no-LLM) "import your products now?" offer with token-free action buttons.
        void notifyConnectedOfferSync(tenantId, 'tiktok', tokens.seller_name ?? null);
        return c.redirect(webAppUrl('/integrations?connected=tiktok&status=ok'), 302);
      } catch (err) {
        void notifyTenantOfConnectionEvent({ tenantId, integration: 'tiktok', status: 'failed', errorMessage: (err as Error).message });
        return c.redirect(
          webAppUrl(`/integrations?connected=tiktok&status=error&message=${encodeURIComponent((err as Error).message)}`),
          302,
        );
      }
    },
  }),
];
