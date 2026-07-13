import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { discordTenantIntegrationConfigSchema } from '../shared/types';
import { listTenantIntegrationsByCode } from '../shared/tenant-integrations';
import { resolveIntegrationVaultSecret } from '../shared/vault';
import { parseDiscordLegacyTenantIntegrationConfig, parseDiscordVaultPayload } from './config';
import { logErrorBrief } from '../../logger/compact-error';
import {
  handleDiscordMessage,
  handleDiscordMessageUpdate,
  type ChannelToTenantMap,
  type ChannelRoute,
} from './agent-bridge';
import { buildTenantToChannels, clearDiscordRuntime, setDiscordRuntime } from './runtime';

export type DiscordBotsHandle = {
  shutdown: () => Promise<void>;
};

/**
 * discord.js caches every message/user/channel it ever sees by default, with NO limit — a persistent
 * Gateway client left running for hours in a memory-capped container (Railway) grows unbounded and
 * eventually OOMs. This app only needs a handful of very recent messages (edit-tracking) and doesn't
 * use presence/typing/voice at all, so cap or zero out everything else per discord.js's own
 * optimization guidance (https://discordjs.guide/popular-topics/cache-management).
 */
const DISCORD_CACHE_LIMITS = Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 50,
  UserManager: 200,
  GuildMemberManager: 0, // no GuildMembers intent requested — nothing to cache here anyway
  PresenceManager: 0,
  VoiceStateManager: 0,
  StageInstanceManager: 0,
  ThreadMemberManager: 0,
});

/**
 * One shared Discord application: single Gateway session via `DISCORD_BOT_TOKEN`.
 * Tenant scope comes from `tenant_integrations` rows (guildId, channelId, consent).
 */
async function startSingleAppDiscordBots(platformToken: string): Promise<DiscordBotsHandle> {
  const rows = await listTenantIntegrationsByCode('discord');
  const channelToTenant: ChannelToTenantMap = new Map<string, ChannelRoute>();

  for (const row of rows) {
    const parsed = discordTenantIntegrationConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      logErrorBrief(`[discord] Invalid tenant_integrations config for row ${row.id} (single-app mode)`, parsed.error);
      continue;
    }
    const cfg = parsed.data;
    if (cfg.enabled === false) {
      console.info(`[discord] Skipping disabled integration row ${row.id} (tenant ${row.tenant_id})`);
      continue;
    }
    const guildId = cfg.guildId?.trim();
    const channelId = cfg.channelId?.trim();
    if (!guildId || !channelId) {
      console.info(`[discord] Skipping row ${row.id} without guildId/channelId (single-app mode)`);
      continue;
    }

    const existing = channelToTenant.get(channelId);
    if (existing) {
      console.warn(
        `[discord] Duplicate channelId ${channelId}: keeping tenant ${existing.tenantId}, skipping row ${row.id} (tenant ${row.tenant_id})`,
      );
      continue;
    }
    channelToTenant.set(channelId, {
      tenantId: row.tenant_id,
      rowId: row.id,
      guildId,
    });
  }

  if (channelToTenant.size === 0) {
    console.info(
      '[discord] Single-app mode: no linked tenants (enabled rows with guildId, channelId, consent).',
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Discord delivers DMs as uncached partials — opt in so MessageCreate still fires.
    // Single-member REST lookups (`guild.members.fetch(userId)`) work without the
    // privileged GuildMembers intent, so we deliberately stay off the privileged list.
    partials: [Partials.Channel, Partials.Message],
    makeCache: DISCORD_CACHE_LIMITS,
  });

  client.once(Events.ClientReady, (c) => {
    console.info(`[discord] Ready (single-app): ${c.user?.tag ?? 'unknown'} — ${channelToTenant.size} channel route(s)`);
  });

  client.on(Events.MessageCreate, (message) => {
    void handleDiscordMessage({ message, channelToTenant, client }).catch((err) => {
      logErrorBrief('[discord] handleDiscordMessage failed', err);
    });
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void handleDiscordMessageUpdate({ oldMessage, newMessage, channelToTenant, client }).catch(
      (err) => {
        logErrorBrief('[discord] handleDiscordMessageUpdate failed', err);
      },
    );
  });

  try {
    await client.login(platformToken);
  } catch (err) {
    logErrorBrief('[discord] login failed (single-app mode)', err);
    await client.destroy();
    return {
      shutdown: async () => {},
    };
  }

  setDiscordRuntime({
    client,
    channelToTenant,
    tenantToChannels: buildTenantToChannels(channelToTenant),
  });

  return {
    shutdown: async () => {
      clearDiscordRuntime();
      try {
        await client.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Legacy: one Gateway client per tenant row; each tenant's bot token lives in Vault (`vaultSecretRef`).
 */
async function startLegacyVaultDiscordBots(): Promise<DiscordBotsHandle> {
  const rows = await listTenantIntegrationsByCode('discord');
  const clients: Client[] = [];

  for (const row of rows) {
    let parsedConfig;
    try {
      parsedConfig = parseDiscordLegacyTenantIntegrationConfig(row.config as Record<string, unknown>);
    } catch (err) {
      logErrorBrief(`[discord] Invalid legacy tenant_integrations config for row ${row.id}`, err);
      continue;
    }

    if (parsedConfig.enabled === false) {
      console.info(`[discord] Skipping disabled integration row ${row.id} (tenant ${row.tenant_id})`);
      continue;
    }

    let token: string;
    try {
      const secretRecord = await resolveIntegrationVaultSecret(parsedConfig.vaultSecretRef);
      const payload = parseDiscordVaultPayload(secretRecord);
      token = payload.token;
    } catch (err) {
      logErrorBrief(`[discord] Vault resolve failed for row ${row.id} (tenant ${row.tenant_id})`, err);
      continue;
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      makeCache: DISCORD_CACHE_LIMITS,
    });

    const tenantId = row.tenant_id;

    client.once(Events.ClientReady, (c) => {
      console.info(`[discord] Ready: ${c.user?.tag ?? 'unknown'} (tenant ${tenantId}, row ${row.id})`);
    });

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      const routing = parsedConfig.routing;
      if (routing?.channelId && message.channelId !== routing.channelId) return;
      if (routing?.guildId && message.guildId !== routing.guildId) return;

      console.info(
        `[discord] message tenant=${tenantId} integration=${row.id} channel=${message.channelId}`,
      );
    });

    try {
      await client.login(token);
      clients.push(client);
    } catch (err) {
      logErrorBrief(`[discord] login failed for row ${row.id} (tenant ${tenantId})`, err);
      await client.destroy();
    }
  }

  if (clients.length === 0) {
    console.info('[discord] No active Discord clients started (legacy: tenant_integrations + Vault).');
  }

  return {
    shutdown: async () => {
      await Promise.all(
        clients.map(async (c) => {
          try {
            await c.destroy();
          } catch {
            /* ignore */
          }
        }),
      );
    },
  };
}

/**
 * Starts Discord Gateway worker(s).
 *
 * - If **`DISCORD_BOT_TOKEN`** is set: **single** client for the platform bot; tenants are routed by
 *   `guildId` / `channelId` in each `tenant_integrations` row.
 * - Otherwise: **legacy** mode — one client per row using Vault `vaultSecretRef` per tenant.
 */
export async function startDiscordBots(): Promise<DiscordBotsHandle> {
  const platformToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (platformToken) {
    return startSingleAppDiscordBots(platformToken);
  }
  return startLegacyVaultDiscordBots();
}
