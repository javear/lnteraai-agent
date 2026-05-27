import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import type { MastraDBMessage } from '@mastra/core/agent';
import { logErrorBrief } from '../logger/compact-error';
import { generalAgent } from '../agents/general-agent';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import type { Platform } from '../integrations/shared/types';
import type { EventCategory } from '../integrations/shared/webhook-event-classifier';
import {
  discordGuildResourceId,
  discordGuildThreadId,
  resolveDiscordChannelsForTenant,
  sendDiscordToTenant,
} from '../integrations/discord/outbound';
import { parseDiscordReplyFromUnknown } from '../processors/discord-reply-formatter';
import type { DiscordReply } from '../integrations/discord/reply-schema';

/**
 * Active mode value. Default mode is `passive` (regular chat); webhook handlers set this to
 * `active` so the agent transcribes the payload into a notification instead of waiting for a
 * user question.
 */
export type AgentMode = 'passive' | 'active';

export const AGENT_MODE_KEY = 'mode';
/** RequestContext key carrying the active-mode marketplace metadata (platform, category, code). */
export const MARKETPLACE_CONTEXT_KEY = 'marketplace';

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
}

const MAX_PAYLOAD_CHARS = 6000;

/**
 * Webhook entry point. Composes the active-mode prompt, runs the agent without memory recall,
 * pushes the rendered response to Discord, then persists the assistant turn (and a small
 * system marker) into the tenant's guild thread so the next user reply stays aligned.
 */
export async function notifyTenantOfMarketplaceEvent(
  input: NotifyTenantOfMarketplaceEventInput,
): Promise<NotifyTenantOfMarketplaceEventResult> {
  const channels = await resolveDiscordChannelsForTenant(input.tenantId);
  if (channels.length === 0) {
    return { status: 'no_channel', deliveredChannels: 0, reason: 'no_linked_channel' };
  }

  const payloadJson = safeStringifyPayload(input.payload);
  const prompt = buildActiveModePrompt({
    platform: input.platform,
    category: input.category,
    code: input.code,
    payloadJson,
  });

  const requestContext = new RequestContext();
  requestContext.set(TENANT_MASTER_ID_KEY, input.tenantId);
  requestContext.set('channel', 'discord');
  requestContext.set(AGENT_MODE_KEY, 'active' satisfies AgentMode);
  requestContext.set(MARKETPLACE_CONTEXT_KEY, {
    platform: input.platform,
    category: input.category,
    code: input.code,
  });

  let answerText = '';
  try {
    // No `memory` option ⇒ no recall, no auto-save. We persist the assistant turn manually
    // below into the guild thread so subsequent user mentions see the notification.
    const answer = await generalAgent.generate(prompt, {
      requestContext,
      maxSteps: 2,
    });
    if (typeof (answer as { text?: unknown }).text === 'string') {
      answerText = (answer as { text: string }).text.trim();
    }
  } catch (err) {
    logErrorBrief(`[active] generalAgent.generate failed (tenant=${input.tenantId})`, err);
    return { status: 'agent_failed', deliveredChannels: 0, reason: 'agent_threw' };
  }

  if (!answerText) {
    return { status: 'empty_response', deliveredChannels: 0, reason: 'empty_response' };
  }

  const reply = toDiscordReply(answerText);
  const result = await sendDiscordToTenant(input.tenantId, reply);
  if (result.delivered.length === 0) {
    return {
      status: 'dispatch_failed',
      deliveredChannels: 0,
      reason: result.skipped[0]?.reason ?? 'unknown_dispatch_failure',
    };
  }

  await persistAssistantTurn({
    tenantId: input.tenantId,
    channels: result.delivered,
    answerText,
    platform: input.platform,
    category: input.category,
    code: input.code,
  });

  return { status: 'delivered', deliveredChannels: result.delivered.length };
}

function toDiscordReply(text: string): DiscordReply {
  // If the agent (against its instructions) happens to emit Discord ops JSON, reuse them
  // verbatim so we get embeds / formatting; otherwise wrap as a single text op.
  const opportunistic = parseDiscordReplyFromUnknown(text);
  if (opportunistic.success) return opportunistic.data;
  return { ops: [{ message_type: 'text', content: text }] };
}

function buildActiveModePrompt(args: {
  platform: Platform;
  category: EventCategory;
  code: string;
  payloadJson: string;
}): string {
  return [
    '[Active mode: marketplace webhook]',
    `platform=${args.platform}`,
    `category=${args.category}`,
    `code=${args.code}`,
    '',
    'Transcribe this event into a short Discord notification for the seller. Follow the active-mode rules in your system instructions.',
    '',
    'Webhook payload (JSON):',
    args.payloadJson,
  ].join('\n');
}

function safeStringifyPayload(payload: unknown): string {
  try {
    const json = JSON.stringify(payload, null, 2);
    if (json.length <= MAX_PAYLOAD_CHARS) return json;
    return json.slice(0, MAX_PAYLOAD_CHARS) + '\n... (truncated)';
  } catch (err) {
    logErrorBrief('[active] failed to stringify webhook payload', err);
    return '{ "_unserializable": true }';
  }
}

async function persistAssistantTurn(args: {
  tenantId: string;
  channels: Array<{ guildId: string; channelId: string }>;
  answerText: string;
  platform: Platform;
  category: EventCategory;
  code: string;
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

    // Small system marker so the next user turn understands what triggered the message.
    const systemMsg: MastraDBMessage = {
      id: randomUUID(),
      role: 'system',
      createdAt: now,
      threadId,
      resourceId,
      content: {
        format: 2,
        parts: [
          {
            type: 'text',
            text: `[Notification trigger] platform=${args.platform} category=${args.category} code=${args.code}`,
          },
        ],
        metadata: {
          channel: 'discord',
          source: 'active-notification',
          marketplace: {
            platform: args.platform,
            category: args.category,
            code: args.code,
          },
        },
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
        metadata: {
          channel: 'discord',
          source: 'active-notification',
          marketplace: {
            platform: args.platform,
            category: args.category,
            code: args.code,
          },
        },
      },
    };

    try {
      await memory.saveMessages({ messages: [systemMsg, assistantMsg] });
    } catch (err) {
      logErrorBrief('[active] memory.saveMessages failed', err);
    }
  }
}
