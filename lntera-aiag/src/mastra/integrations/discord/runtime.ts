import type { Client } from 'discord.js';
import type { ChannelRoute, ChannelToTenantMap } from './agent-bridge';

/**
 * Singleton registry exposing the single-app Discord runtime to other modules
 * (notably the marketplace-webhook → general-agent → Discord notification path).
 *
 * Today the runtime is built by `startSingleAppDiscordBots` and stored on `globalThis`
 * so Mastra hot reloads do not lose the reference. Legacy multi-token mode does not
 * publish a runtime — proactive outbound is gated on single-app mode.
 */
export interface DiscordRuntime {
  client: Client;
  /** Forward map: channelId -> tenant route. Built once at startup from tenant_integrations. */
  channelToTenant: ChannelToTenantMap;
  /** Reverse index: tenantId -> all linked routes (today one per tenant, kept as array for future multi-channel). */
  tenantToChannels: Map<string, ChannelRoute[]>;
}

const GLOBAL_KEY = '__lnteraDiscordRuntime';

type Holder = { runtime: DiscordRuntime | null };

function holder(): Holder {
  const g = globalThis as Record<string, unknown>;
  const existing = g[GLOBAL_KEY] as Holder | undefined;
  if (existing) return existing;
  const created: Holder = { runtime: null };
  g[GLOBAL_KEY] = created;
  return created;
}

export function setDiscordRuntime(runtime: DiscordRuntime): void {
  holder().runtime = runtime;
}

export function clearDiscordRuntime(): void {
  holder().runtime = null;
}

export function getDiscordRuntime(): DiscordRuntime | null {
  return holder().runtime;
}

/**
 * Build the reverse index `tenantId -> ChannelRoute[]` from an existing forward map.
 * Stable, predictable iteration order (preserves insertion order of the forward map).
 */
export function buildTenantToChannels(channelToTenant: ChannelToTenantMap): Map<string, ChannelRoute[]> {
  const out = new Map<string, ChannelRoute[]>();
  for (const [channelId, route] of channelToTenant) {
    const list = out.get(route.tenantId) ?? [];
    list.push({ ...route });
    out.set(route.tenantId, list);
    // mark channelId so we can pair the reverse entry with a known channel if needed later
    // (no field added to keep type compatible with ChannelRoute).
    void channelId;
  }
  return out;
}
