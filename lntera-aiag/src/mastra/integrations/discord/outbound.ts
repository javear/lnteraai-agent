import { logErrorBrief } from '../../logger/compact-error';
import { getTenantIntegration } from '../shared/tenant-integrations';
import { discordTenantIntegrationConfigSchema } from '../shared/types';
import {
  dispatchDiscordOps,
  type ChannelDispatchContext,
  type SendableChannel,
} from './dispatcher';
import type { DiscordReply } from './reply-schema';
import { getDiscordRuntime } from './runtime';

/**
 * Outbound (proactive) Discord helpers used by webhook-driven notifications.
 *
 * Reads `tenant_integrations.config` for freshness so newly-linked tenants are reachable
 * immediately, falling back to the in-memory `tenantToChannels` registry (which is built
 * at bot startup and survives Mastra hot reloads).
 */

export interface ResolvedDiscordChannel {
  tenantId: string;
  guildId: string;
  channelId: string;
  rowId: string | null;
}

/**
 * Look up the Discord channel(s) linked to a tenant. Today each tenant has at most one
 * `discord` row (unique `(tenant_id, integration_code)`), so the result is one entry or
 * none, but the array shape is kept to absorb a future multi-channel design without a
 * call-site rewrite.
 */
export async function resolveDiscordChannelsForTenant(
  tenantId: string,
): Promise<ResolvedDiscordChannel[]> {
  try {
    const row = await getTenantIntegration(tenantId, 'discord');
    if (row) {
      const parsed = discordTenantIntegrationConfigSchema.safeParse(row.config);
      if (parsed.success) {
        const cfg = parsed.data;
        const guildId = cfg.guildId?.trim();
        const channelId = cfg.channelId?.trim();
        if (cfg.enabled !== false && guildId && channelId) {
          return [{ tenantId, guildId, channelId, rowId: row.id }];
        }
      }
    }
  } catch (err) {
    logErrorBrief(`[discord] resolveDiscordChannelsForTenant DB read failed (tenant=${tenantId})`, err);
  }

  const runtime = getDiscordRuntime();
  if (!runtime) return [];
  const routes = runtime.tenantToChannels.get(tenantId) ?? [];
  const out: ResolvedDiscordChannel[] = [];
  for (const route of routes) {
    for (const [channelId, r] of runtime.channelToTenant) {
      if (r.tenantId === route.tenantId) {
        out.push({
          tenantId: route.tenantId,
          guildId: route.guildId,
          channelId,
          rowId: route.rowId ?? null,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Send a structured `DiscordReply` to the channel(s) linked to a tenant. Each linked
 * channel receives the same payload independently; one failure does not abort the rest.
 */
export interface SendDiscordToTenantResult {
  delivered: ResolvedDiscordChannel[];
  skipped: Array<{ reason: string; channel?: ResolvedDiscordChannel }>;
}

export async function sendDiscordToTenant(
  tenantId: string,
  reply: DiscordReply,
): Promise<SendDiscordToTenantResult> {
  const result: SendDiscordToTenantResult = { delivered: [], skipped: [] };

  const runtime = getDiscordRuntime();
  if (!runtime) {
    result.skipped.push({ reason: 'discord_runtime_missing' });
    return result;
  }
  if (!runtime.client.isReady()) {
    result.skipped.push({ reason: 'discord_client_not_ready' });
    return result;
  }

  const channels = await resolveDiscordChannelsForTenant(tenantId);
  if (channels.length === 0) {
    result.skipped.push({ reason: 'no_linked_channel' });
    return result;
  }

  for (const target of channels) {
    let channel: SendableChannel | null = null;
    try {
      const fetched = (await runtime.client.channels.fetch(target.channelId)) as unknown;
      channel = toSendableChannel(fetched);
    } catch (err) {
      logErrorBrief(`[discord] outbound channels.fetch failed (channel=${target.channelId})`, err);
    }
    if (!channel) {
      result.skipped.push({ reason: 'channel_not_sendable', channel: target });
      continue;
    }

    const ctx: ChannelDispatchContext = {
      kind: 'channel',
      channel,
      client: runtime.client,
      guildId: target.guildId,
    };
    try {
      await dispatchDiscordOps(reply, ctx);
      result.delivered.push(target);
    } catch (err) {
      logErrorBrief(`[discord] outbound dispatch failed (channel=${target.channelId})`, err);
      result.skipped.push({ reason: 'dispatch_failed', channel: target });
    }
  }

  return result;
}

function toSendableChannel(channelRaw: unknown): SendableChannel | null {
  const channel = channelRaw as {
    isSendable?: () => boolean;
    send?: unknown;
    sendTyping?: unknown;
    messages?: { fetch?: unknown };
  } | null;
  if (!channel) return null;
  if (typeof channel.isSendable === 'function' && !channel.isSendable()) return null;
  if (typeof channel.send !== 'function') return null;
  if (typeof channel.sendTyping !== 'function') return null;
  if (typeof channel.messages?.fetch !== 'function') return null;
  return channel as unknown as SendableChannel;
}

/**
 * Stable memory thread / resource ids for messages posted to a Discord guild channel.
 * Mirrors the format used by `agent-bridge.ts` so user mentions and webhook notifications
 * stay aligned on the same thread.
 */
export function discordGuildThreadId(args: { guildId: string; channelId: string }): string {
  return `guild:${args.guildId}:channel:${args.channelId}`;
}

export function discordGuildResourceId(tenantId: string): string {
  return tenantId;
}
