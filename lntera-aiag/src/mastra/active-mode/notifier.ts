import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import type { MastraDBMessage } from '@mastra/core/agent';
import { logErrorBrief } from '../logger/compact-error';
import { generalAgent } from '../agents/general-agent';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { resolveAgentTextFromResult } from '../integrations/shared/agent-result-text';
import type { Platform } from '../integrations/shared/types';
import type { EventCategory } from '../integrations/shared/webhook-event-classifier';
import { buildMarketplaceNotification } from '../integrations/shared/marketplace-status';
import {
  discordGuildResourceId,
  discordGuildThreadId,
  resolveDiscordChannelsForTenant,
  sendDiscordToTenant,
} from '../integrations/discord/outbound';
import { parseDiscordReplyFromUnknown } from '../processors/discord-reply-formatter';
import { sanitizeMarkdownTablesForDiscord } from '../processors/discord-markdown-sanitize';
import type { DiscordReply } from '../integrations/discord/reply-schema';
import { deliverTenantWebNotification } from './web-delivery';

/**
 * Active mode value. Default mode is `passive` (regular chat); webhook handlers set this to
 * `active` so the agent transcribes the payload into a notification instead of waiting for a
 * user question.
 */
export type AgentMode = 'passive' | 'active';

export const AGENT_MODE_KEY = 'mode';
/** RequestContext key carrying the active-mode marketplace metadata (platform, category, code). */
export const MARKETPLACE_CONTEXT_KEY = 'marketplace';
/** RequestContext key carrying the active-mode integration connection metadata. */
export const CONNECTION_CONTEXT_KEY = 'connection';

export interface NotifyTenantOfMarketplaceEventInput {
  tenantId: string;
  platform: Platform;
  category: EventCategory;
  /** Stable identifier for the event, e.g. `code:3` or `ORDER_STATUS_CHANGE`. */
  code: string;
  /** Raw webhook payload (already parsed JSON). */
  payload: unknown;
}

export interface NotifyTenantOfMarketplaceEventResult {
  status: 'delivered' | 'no_channel' | 'empty_response' | 'agent_failed' | 'dispatch_failed';
  deliveredChannels: number;
  reason?: string;
  /** True when the AI text was unavailable and a minimal deterministic line was sent instead. */
  usedFallback?: boolean;
}

export type ConnectionIntegration = 'tiktok' | 'shopee' | 'groq';
export type ConnectionStatus = 'connected' | 'failed';

export interface NotifyTenantOfConnectionEventInput {
  tenantId: string;
  integration: ConnectionIntegration;
  status: ConnectionStatus;
  shopName?: string | null;
  errorMessage?: string | null;
}

export interface NotifyTenantOfConnectionEventResult {
  status: 'delivered' | 'no_channel' | 'empty_response' | 'agent_failed' | 'dispatch_failed' | 'fallback_delivered';
  deliveredChannels: number;
  reason?: string;
}

/**
 * Webhook entry point. Composes the active-mode prompt, runs the agent without memory recall,
 * pushes the rendered response to Discord, then persists the assistant turn (and a small
 * system marker) into the tenant's guild thread so the next user reply stays aligned.
 */
export async function notifyTenantOfMarketplaceEvent(
  input: NotifyTenantOfMarketplaceEventInput,
): Promise<NotifyTenantOfMarketplaceEventResult> {
  // Deterministic, human-readable transcription — consistent across every event, with the status
  // code mapped to plain language (no raw codes, no LLM ambiguity, no internal ids like shop_id).
  const { heading, text } = buildMarketplaceNotification({
    platform: input.platform,
    category: input.category,
    code: input.code,
    payload: input.payload,
  });

  // 1) Tenant's own platform (web/desktop/mobile) — ALWAYS, even with no Discord linked.
  await deliverTenantWebNotification({
    tenantId: input.tenantId,
    text,
    heading,
    marketplace: { platform: input.platform, category: input.category, code: input.code },
    kind: 'marketplace',
  });

  // 2) Discord — only when the tenant has a linked channel (no separate heading field there).
  const channels = await resolveDiscordChannelsForTenant(input.tenantId);
  if (channels.length === 0) {
    return { status: 'delivered', deliveredChannels: 0, reason: 'web_only' };
  }

  const discordText = `${heading}\n${text}`;
  const reply = toDiscordReply(discordText);
  const result = await sendDiscordToTenant(input.tenantId, reply);
  if (result.delivered.length === 0) {
    // Discord dispatch failed, but the web notification already went out.
    return {
      status: 'delivered',
      deliveredChannels: 0,
      reason: result.skipped[0]?.reason ?? 'discord_dispatch_failed',
    };
  }

  await persistAssistantTurn({
    tenantId: input.tenantId,
    channels: result.delivered,
    answerText: discordText,
    systemMarkerText: `[Notification trigger] platform=${input.platform} category=${input.category} code=${input.code}`,
    metadata: { marketplace: { platform: input.platform, category: input.category, code: input.code } },
  });

  return { status: 'delivered', deliveredChannels: result.delivered.length };
}

function toDiscordReply(text: string): DiscordReply {
  const sanitized = sanitizeMarkdownTablesForDiscord(text);
  const opportunistic = parseDiscordReplyFromUnknown(sanitized);
  if (opportunistic.success) return opportunistic.data;
  return { ops: [{ message_type: 'text', content: sanitized }] };
}

async function persistAssistantTurn(args: {
  tenantId: string;
  channels: Array<{ guildId: string; channelId: string }>;
  answerText: string;
  systemMarkerText: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const memory = await generalAgent.getMemory();
  if (!memory) return;

  for (const target of args.channels) {
    const threadId = discordGuildThreadId(target);
    const resourceId = discordGuildResourceId(args.tenantId);

    try {
      const existing = await memory.getThreadById({ threadId });
      if (!existing) {
        await memory.saveThread({
          thread: {
            id: threadId,
            resourceId,
            title: `Discord #${target.channelId}`,
            metadata: { channel: 'discord', source: 'active-notification' },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    } catch (err) {
      logErrorBrief('[active] memory.saveThread failed', err);
    }

    const now = new Date();

    const systemMsg: MastraDBMessage = {
      id: randomUUID(),
      role: 'system',
      createdAt: now,
      threadId,
      resourceId,
      content: {
        format: 2,
        parts: [{ type: 'text', text: args.systemMarkerText }],
        metadata: { channel: 'discord', source: 'active-notification', ...args.metadata },
      },
    };

    const assistantMsg: MastraDBMessage = {
      id: randomUUID(),
      role: 'assistant',
      createdAt: new Date(now.getTime() + 1),
      threadId,
      resourceId,
      content: {
        format: 2,
        parts: [{ type: 'text', text: args.answerText }],
        metadata: { channel: 'discord', source: 'active-notification', ...args.metadata },
      },
    };

    try {
      await memory.saveMessages({ messages: [systemMsg, assistantMsg] });
    } catch (err) {
      logErrorBrief('[active] memory.saveMessages failed', err);
    }
  }
}

export async function notifyTenantOfConnectionEvent(
  input: NotifyTenantOfConnectionEventInput,
): Promise<NotifyTenantOfConnectionEventResult> {
  const prompt = buildConnectionEventPrompt(input);

  const requestContext = new RequestContext();
  requestContext.set(TENANT_MASTER_ID_KEY, input.tenantId);
  requestContext.set('channel', 'discord');
  requestContext.set(AGENT_MODE_KEY, 'active' satisfies AgentMode);
  requestContext.set(CONNECTION_CONTEXT_KEY, {
    integration: input.integration,
    status: input.status,
    shopName: input.shopName ?? null,
    errorMessage: input.errorMessage ?? null,
  });

  let answerText = '';
  try {
    const answer = await generalAgent.generate(prompt, { requestContext, maxSteps: 2 });
    answerText = resolveAgentTextFromResult(
      answer as { text?: unknown; tripwire?: { reason?: unknown } },
    );
  } catch (err) {
    logErrorBrief(`[active:connection] generalAgent.generate failed (tenant=${input.tenantId})`, err);
  }

  // When the agent produced nothing, fall back to a deterministic plain-text message.
  const usedFallback = !answerText;
  const effectiveText = answerText || buildFallbackConnectionText(input);

  // 1) Tenant's own platform — ALWAYS.
  await deliverTenantWebNotification({
    tenantId: input.tenantId,
    text: effectiveText,
    heading: `${platformDisplayName(input.integration)} ${input.status === 'connected' ? 'connected' : 'connection failed'}`,
    kind: 'connection',
  });

  // 2) Discord — only when linked.
  const channels = await resolveDiscordChannelsForTenant(input.tenantId);
  if (channels.length === 0) {
    return { status: 'delivered', deliveredChannels: 0, reason: 'web_only' };
  }

  const reply = toDiscordReply(effectiveText);
  const result = await sendDiscordToTenant(input.tenantId, reply);
  if (result.delivered.length === 0) {
    return {
      status: 'delivered',
      deliveredChannels: 0,
      reason: result.skipped[0]?.reason ?? 'discord_dispatch_failed',
    };
  }

  // Only persist agent-authored turns to the thread (mirrors the prior fallback behavior).
  if (!usedFallback) {
    await persistAssistantTurn({
      tenantId: input.tenantId,
      channels: result.delivered,
      answerText: effectiveText,
      systemMarkerText: `[Notification trigger] integration=${input.integration} status=${input.status}`,
      metadata: { connection: { integration: input.integration, status: input.status } },
    });
  }

  return {
    status: usedFallback ? 'fallback_delivered' : 'delivered',
    deliveredChannels: result.delivered.length,
  };
}

function buildConnectionEventPrompt(input: NotifyTenantOfConnectionEventInput): string {
  const lines = [
    '[Active mode: integration connection event]',
    `integration=${input.integration}`,
    `status=${input.status}`,
  ];
  if (input.shopName) lines.push(`shop_name=${input.shopName}`);
  if (input.errorMessage) lines.push(`error=${input.errorMessage}`);
  lines.push('');
  const name = platformDisplayName(input.integration);
  if (input.status === 'connected') {
    lines.push(
      `The tenant just successfully connected their ${name}.` +
        (input.shopName ? ` Shop name: ${input.shopName}.` : '') +
        ' Write a short, friendly Discord notification confirming the connection is active. Follow the active-mode rules in your system instructions.',
    );
  } else {
    lines.push(
      `The tenant's ${name} connection failed.` +
        (input.errorMessage ? ` Reason: ${input.errorMessage}.` : '') +
        ' Write a short Discord notification informing the user and suggesting they try again or check their credentials. Follow the active-mode rules in your system instructions.',
    );
  }
  return lines.join('\n');
}

function buildFallbackConnectionText(input: NotifyTenantOfConnectionEventInput): string {
  const name = platformDisplayName(input.integration);
  if (input.status === 'connected') {
    return input.shopName
      ? `✅ **${name} connected** — ${input.shopName} is now linked to your workspace.`
      : `✅ **${name} connected** — your integration is now active.`;
  }
  return input.errorMessage
    ? `⚠️ **${name} connection failed** — ${input.errorMessage}`
    : `⚠️ **${name} connection failed.** Check your credentials and try again.`;
}

function platformDisplayName(integration: ConnectionIntegration): string {
  if (integration === 'tiktok') return 'TikTok Shop';
  if (integration === 'shopee') return 'Shopee';
  return 'Groq';
}
