import { randomUUID } from 'node:crypto';
import { ChannelType, type Client, type Message, type PartialMessage } from 'discord.js';
import { RequestContext } from '@mastra/core/request-context';
import type { MastraDBMessage } from '@mastra/core/agent';
import { logErrorBrief } from '../../logger/compact-error';
import { generalAgent } from '../../agents/general-agent';
import { friendlyAgentLimitMessage } from '../shared/friendly-error';
import { resolveAgentTextFromResult } from '../shared/agent-result-text';
import { sanitizeMarkdownTablesForDiscord } from '../../processors/discord-markdown-sanitize';
import { buildGeneralAgentMemoryBinding } from '../../agents/general-agent-memory';
import { parseDiscordReplyFromUnknown } from '../../processors/discord-reply-formatter';
import { TENANT_MASTER_ID_KEY } from '../shared/marketplace-auth';
import { dispatchDiscordOps, type DispatchContext } from './dispatcher';
import type { DiscordReply } from './reply-schema';
import {
  resolveDiscordAttachmentDownloadUrl,
  type DiscordAttachmentInfo,
} from '../shared/discord-attachment-urls';

export type { DiscordAttachmentInfo } from '../shared/discord-attachment-urls';

export type ChannelRoute = {
  tenantId: string;
  rowId: string;
  guildId: string;
};

export type ChannelToTenantMap = Map<string, ChannelRoute>;

export interface HandleDiscordMessageArgs {
  message: Message;
  channelToTenant: ChannelToTenantMap;
  client: Client;
}

interface ResolvedTarget {
  tenantId: string;
  rowId?: string;
  thread: string;
  resource: string;
  isDM: boolean;
}

export interface HandleDiscordMessageUpdateArgs {
  oldMessage: Message | PartialMessage;
  newMessage: Message | PartialMessage;
  channelToTenant: ChannelToTenantMap;
  client: Client;
}

/**
 * Handles edited messages. Discord does not re-fire `MessageCreate` on edit — users often
 * send a message first, then edit it to add `@bot`. We only act when the edited message
 * mentions the bot or is a DM, and when content/attachments actually changed.
 */
export async function handleDiscordMessageUpdate(args: HandleDiscordMessageUpdateArgs): Promise<void> {
  const { oldMessage, newMessage, channelToTenant, client } = args;

  if (newMessage.author?.bot) return;
  if (!client.user?.id) return;

  const fullMessage = await ensureFullMessage(newMessage);

  const isDM = fullMessage.channel.type === ChannelType.DM;
  const isMention = fullMessage.mentions.has(client.user.id, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: false,
  });

  if (!isMention && !isDM) return;

  if (!messageEditChanged(oldMessage, fullMessage)) return;

  await handleDiscordMessage({ message: fullMessage, channelToTenant, client });
}

/**
 * Main entrypoint called from `bot.ts` `MessageCreate` (and indirectly from `MessageUpdate`).
 *
 * Behavior:
 * - Ignores bot self / other bots.
 * - Resolves tenant from `channelId` (server) or shared linked guild (DM).
 * - Saves EVERY non-bot message to Mastra Memory (user message persisted), even when not mentioned.
 * - Only calls `generalAgent.generate` when the bot was mentioned or the message is a DM.
 * - Validates structured output against `discordReplySchema`; falls back to a plain text reply
 *   if validation/generation fails so the user always hears something.
 */
export async function handleDiscordMessage(args: HandleDiscordMessageArgs): Promise<void> {
  const { message, channelToTenant, client } = args;

  if (message.author.bot) return;
  if (!client.user?.id) return;

  const fullMessage = await ensureFullMessage(message);

  const isDM = fullMessage.channel.type === ChannelType.DM;
  const isMention = fullMessage.mentions.has(client.user.id, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: false,
  });

  const target = await resolveTarget({ message: fullMessage, channelToTenant, client, isDM });
  if (!target) {
    if (isDM || isMention) {
      await safeReply(
        fullMessage,
        'I could not figure out which workspace this belongs to. Please mention me in your linked server channel first.',
      );
    }
    return;
  }

  const attachments = collectAttachments(fullMessage);
  const userText = buildUserText(fullMessage, client.user.id, attachments);

  await persistUserMessage({
    target,
    message: fullMessage,
    text: userText,
    attachments,
    isMention,
    isDM,
  });

  if (!isMention && !isDM) {
    // Stored for context only; no LLM call.
    return;
  }

  const requestContext = new RequestContext();
  requestContext.set(TENANT_MASTER_ID_KEY, target.tenantId);
  requestContext.set('channel', 'discord');
  requestContext.set('discord', {
    guildId: fullMessage.guildId ?? null,
    channelId: fullMessage.channelId,
    messageId: fullMessage.id,
    authorId: fullMessage.author.id,
    authorTag: fullMessage.author.tag,
    isDM,
    attachments,
  });

  await typingIndicator(fullMessage);

  let reply: DiscordReply | null = null;
  let fallbackText: string | null = null;
  try {
    // Single LLM pass: tools allowed, plain text answer in the user's language.
    // We do NOT run a second formatting pass because Groq routinely returns
    // either the JSON Schema or tool_use_failed when forced to format JSON.
    const answer = await generalAgent.generate(userText, {
      requestContext,
      memory: buildGeneralAgentMemoryBinding({
        thread: target.thread,
        resource: target.resource,
      }),
      maxSteps: 6,
    });

    const answerText = resolveAgentTextFromResult(answer as { text?: unknown; tripwire?: { reason?: unknown } });

    if (answerText) {
      const discordText = sanitizeMarkdownTablesForDiscord(answerText);
      // If the model already emitted a Discord ops object (e.g. agent instructions told
      // it to), reuse it. Otherwise fall back to a single text op so the user always
      // sees the answer instead of raw JSON.
      const opportunistic = parseDiscordReplyFromUnknown(discordText);
      if (opportunistic.success) {
        reply = opportunistic.data;
      } else {
        fallbackText = discordText;
      }
    } else {
      fallbackText = 'Sorry, I could not produce a response. Please try again.';
    }
  } catch (err) {
    logErrorBrief('[discord] generalAgent.generate failed', err);
    // Provider-agnostic apology (Groq + Gemini, incl. retry-after / oversize); generic otherwise.
    fallbackText =
      friendlyAgentLimitMessage(err) ?? 'Sorry, something went wrong while answering. Please try again.';
  }

  const ctx: DispatchContext = { kind: 'reply', message: fullMessage, client };
  if (reply) {
    await dispatchDiscordOps(reply, ctx);
  } else if (fallbackText) {
    await dispatchDiscordOps(
      { ops: [{ message_type: 'text', content: fallbackText, to_message_id: fullMessage.id }] },
      ctx,
    );
  }
}

async function resolveTarget(args: {
  message: Message;
  channelToTenant: ChannelToTenantMap;
  client: Client;
  isDM: boolean;
}): Promise<ResolvedTarget | null> {
  const { message, channelToTenant, client, isDM } = args;

  if (!isDM) {
    const route = channelToTenant.get(message.channelId);
    if (!route) return null;
    if (message.guildId !== route.guildId) return null;
    return {
      tenantId: route.tenantId,
      rowId: route.rowId,
      thread: `guild:${route.guildId}:channel:${message.channelId}`,
      resource: route.tenantId,
      isDM: false,
    };
  }

  // DM: pick a tenant whose linked guild the author belongs to. Disambiguate when multiple.
  const authorId = message.author.id;
  const matches = new Map<string, ChannelRoute>(); // tenantId -> route
  for (const route of channelToTenant.values()) {
    if (matches.has(route.tenantId)) continue;
    const guild = client.guilds.cache.get(route.guildId);
    if (!guild) continue;
    try {
      const member = guild.members.cache.get(authorId) ?? (await guild.members.fetch(authorId));
      if (member) {
        matches.set(route.tenantId, route);
      }
    } catch {
      // Not a member of this guild — skip.
    }
  }

  if (matches.size !== 1) return null;
  const only = [...matches.values()][0];
  return {
    tenantId: only.tenantId,
    rowId: only.rowId,
    thread: `dm:user:${authorId}`,
    resource: only.tenantId,
    isDM: true,
  };
}

function stripMentions(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(/<@&\d+>/g, '')
    .replace(/\s{2,}/g, ' ');
}

/** Discord may deliver partial messages (especially DMs/edits); attachments need a full fetch. */
async function ensureFullMessage(message: Message | PartialMessage): Promise<Message> {
  if (!message.partial) return message as Message;
  try {
    return await message.fetch();
  } catch (err) {
    logErrorBrief('[discord] message.fetch failed (partial message)', err);
    return message as unknown as Message;
  }
}

function messageEditChanged(oldMessage: Message | PartialMessage, newMessage: Message): boolean {
  if (oldMessage.partial) return true;
  const oldContent = oldMessage.content ?? '';
  const newContent = newMessage.content ?? '';
  if (oldContent !== newContent) return true;

  const oldIds = [...oldMessage.attachments.keys()].sort().join(',');
  const newIds = [...newMessage.attachments.keys()].sort().join(',');
  return oldIds !== newIds;
}

function collectAttachments(message: Message): DiscordAttachmentInfo[] {
  return [...message.attachments.values()].map((a) => {
    const url = a.url ?? '';
    const proxyUrl = a.proxyURL ?? null;
    const downloadUrl = resolveDiscordAttachmentDownloadUrl({ url, proxyUrl });
    return {
      id: a.id,
      name: a.name ?? 'attachment',
      url,
      proxyUrl,
      downloadUrl,
      contentType: a.contentType ?? null,
      size: a.size,
    };
  });
}

function formatAttachmentBlock(attachments: DiscordAttachmentInfo[]): string {
  if (attachments.length === 0) return '';
  const imageUrls = attachments
    .filter((a) => a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name))
    .map((a) => a.downloadUrl);
  const lines = attachments.map((a, i) => {
    const type = a.contentType ?? 'unknown';
    const sizeLabel = a.size > 0 ? `${Math.max(1, Math.round(a.size / 1024))}KB` : 'unknown size';
    return `${i + 1}. ${a.name} (${type}, ${sizeLabel})\n   downloadUrl: ${a.downloadUrl}`;
  });
  let block = `\n\n[Attachments]\nUse each downloadUrl exactly (including ?ex=…&hm=…) in product tool imageUrls.\n${lines.join('\n')}`;
  if (imageUrls.length > 0) {
    block += `\n[imageUrls for tools]\n${JSON.stringify(imageUrls)}`;
  }
  return block;
}

function buildUserText(
  message: Message,
  botUserId: string,
  attachments: DiscordAttachmentInfo[],
): string {
  const strippedText = stripMentions(message.content ?? '', botUserId).trim();
  const attachmentBlock = formatAttachmentBlock(attachments);
  if (strippedText.length === 0 && attachments.length === 0) {
    return '(no text or attachments)';
  }
  if (strippedText.length === 0) {
    return `(no text)${attachmentBlock}`;
  }
  return `${strippedText}${attachmentBlock}`;
}

async function persistUserMessage(args: {
  target: ResolvedTarget;
  message: Message;
  text: string;
  attachments: DiscordAttachmentInfo[];
  isMention: boolean;
  isDM: boolean;
}): Promise<void> {
  const memory = await generalAgent.getMemory();
  if (!memory) return;

  const { target, message } = args;

  // Ensure the thread exists so non-mention saves don't fail before the agent's first turn.
  try {
    const existing = await memory.getThreadById({ threadId: target.thread });
    if (!existing) {
      await memory.saveThread({
        thread: {
          id: target.thread,
          resourceId: target.resource,
          title: defaultThreadTitle(args),
          metadata: { channel: 'discord', isDM: args.isDM },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  } catch (err) {
    logErrorBrief('[discord] memory.saveThread failed', err);
  }

  const db: MastraDBMessage = {
    id: randomUUID(),
    role: 'user',
    createdAt: message.createdAt ?? new Date(),
    threadId: target.thread,
    resourceId: target.resource,
    content: {
      format: 2,
      parts: [{ type: 'text', text: args.text }],
      metadata: {
        channel: 'discord',
        discord: {
          messageId: message.id,
          channelId: message.channelId,
          guildId: message.guildId ?? null,
          authorId: message.author.id,
          authorTag: message.author.tag,
          isMention: args.isMention,
          isDM: args.isDM,
          attachments: args.attachments,
        },
      },
    },
  };

  try {
    await memory.saveMessages({ messages: [db] });
  } catch (err) {
    logErrorBrief('[discord] memory.saveMessages failed', err);
  }
}

function defaultThreadTitle(args: {
  target: ResolvedTarget;
  message: Message;
  isDM: boolean;
}): string {
  if (args.isDM) return `Discord DM ${args.message.author.tag}`;
  const channelName =
    'name' in args.message.channel && typeof args.message.channel.name === 'string'
      ? args.message.channel.name
      : args.message.channelId;
  return `Discord #${channelName}`;
}

async function typingIndicator(message: Message): Promise<void> {
  const ch = message.channel as unknown as { sendTyping?: () => Promise<void> };
  if (typeof ch.sendTyping === 'function') {
    try {
      await ch.sendTyping();
    } catch {
      /* ignore */
    }
  }
}

async function safeReply(message: Message, text: string): Promise<void> {
  try {
    await message.reply({ content: text });
  } catch (err) {
    logErrorBrief('[discord] safe reply failed', err);
  }
}
