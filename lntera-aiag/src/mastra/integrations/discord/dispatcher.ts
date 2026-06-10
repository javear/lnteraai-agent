import {
  AttachmentBuilder,
  EmbedBuilder,
  type Client,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import { logErrorBrief } from '../../logger/compact-error';
import type {
  DiscordReply,
  DiscordReplyOp,
  discordTextOpSchema,
  discordReactionOpSchema,
  discordImageOpSchema,
  discordFileOpSchema,
  discordEmbedOpSchema,
  discordTypingOpSchema,
} from './reply-schema';
import type { z } from 'zod';

type TextOp = z.infer<typeof discordTextOpSchema>;
type ReactionOp = z.infer<typeof discordReactionOpSchema>;
type ImageOp = z.infer<typeof discordImageOpSchema>;
type FileOp = z.infer<typeof discordFileOpSchema>;
type EmbedOp = z.infer<typeof discordEmbedOpSchema>;
type TypingOp = z.infer<typeof discordTypingOpSchema>;

/**
 * Reply mode: dispatching in response to an incoming Discord `MessageCreate`.
 * `to_message_id` / reactions / `message.reply` are all available.
 */
export interface ReplyDispatchContext {
  kind: 'reply';
  message: Message;
  client: Client;
  logError?: (msg: string, err: unknown) => void;
}

/**
 * Channel mode: dispatching unsolicited content (e.g. webhook-driven notifications) to a
 * specific channel. There is no triggering `Message`, so ops that require one (`reaction`,
 * `to_message_id`) become no-ops with a warning.
 */
export interface ChannelDispatchContext {
  kind: 'channel';
  channel: SendableChannel;
  client: Client;
  /** Optional, used only for log context. */
  guildId?: string | null;
  logError?: (msg: string, err: unknown) => void;
}

export type DispatchContext = ReplyDispatchContext | ChannelDispatchContext;

const DISCORD_TEXT_LIMIT = 2000;

/**
 * Execute every op in order. One failed op never blocks subsequent ops; failures are logged.
 */
export async function dispatchDiscordOps(reply: DiscordReply, ctx: DispatchContext): Promise<void> {
  for (const op of reply.ops) {
    try {
      await dispatchOne(op, ctx);
    } catch (err) {
      (ctx.logError ?? defaultLogError)(`[discord] dispatch op failed (${op.message_type})`, err);
    }
  }
}

function defaultLogError(msg: string, err: unknown): void {
  logErrorBrief(msg, err);
}

async function dispatchOne(op: DiscordReplyOp, ctx: DispatchContext): Promise<void> {
  switch (op.message_type) {
    case 'text':
      await sendText(op, ctx);
      return;
    case 'reaction':
      await sendReaction(op, ctx);
      return;
    case 'image':
      await sendAttachment(op, ctx, defaultAttachmentName(op.content, 'image'));
      return;
    case 'file':
      await sendAttachment(op, ctx, op.name ?? defaultAttachmentName(op.content, 'file'));
      return;
    case 'embed':
      await sendEmbed(op, ctx);
      return;
    case 'typing':
      await sendTyping(op, ctx);
      return;
    case 'noop':
      return;
  }
}

async function sendText(op: TextOp, ctx: DispatchContext): Promise<void> {
  const chunks = splitMessageContent(op.content, DISCORD_TEXT_LIMIT);
  const channel = getSendableChannel(ctx);
  if (!channel) return;

  if (op.to_message_id && ctx.kind === 'reply') {
    const target = await fetchMessage(ctx, op.to_message_id);
    if (target) {
      await target.reply({ content: chunks[0] });
      for (const extra of chunks.slice(1)) {
        await channel.send({ content: extra });
      }
      return;
    }
  }

  for (const chunk of chunks) {
    await channel.send({ content: chunk });
  }
}

async function sendReaction(op: ReactionOp, ctx: DispatchContext): Promise<void> {
  if (ctx.kind !== 'reply') {
    (ctx.logError ?? defaultLogError)('[discord] reaction op skipped in channel mode', {
      to_message_id: op.to_message_id,
    });
    return;
  }
  const target = await fetchMessage(ctx, op.to_message_id);
  if (!target) return;
  await target.react(op.content);
}

async function sendAttachment(
  op: ImageOp | FileOp,
  ctx: DispatchContext,
  filename: string,
): Promise<void> {
  const channel = getSendableChannel(ctx);
  if (!channel) return;

  const attachment = new AttachmentBuilder(op.content, { name: filename });
  const caption = 'caption' in op && op.caption ? op.caption : undefined;
  const payload: MessageCreateOptions = caption
    ? { content: caption, files: [attachment] }
    : { files: [attachment] };

  if (op.to_message_id && ctx.kind === 'reply') {
    const target = await fetchMessage(ctx, op.to_message_id);
    if (target) {
      await target.reply(payload);
      return;
    }
  }
  await channel.send(payload);
}

async function sendEmbed(op: EmbedOp, ctx: DispatchContext): Promise<void> {
  const channel = getSendableChannel(ctx);
  if (!channel) return;

  const embed = new EmbedBuilder();
  if (op.title) embed.setTitle(op.title);
  if (op.description) embed.setDescription(op.description);
  if (op.url) embed.setURL(op.url);
  if (typeof op.color === 'number') embed.setColor(op.color);
  if (op.fields && op.fields.length > 0) embed.addFields(op.fields);
  if (op.footer) embed.setFooter({ text: op.footer });

  if (op.to_message_id && ctx.kind === 'reply') {
    const target = await fetchMessage(ctx, op.to_message_id);
    if (target) {
      await target.reply({ embeds: [embed] });
      return;
    }
  }
  await channel.send({ embeds: [embed] });
}

async function sendTyping(op: TypingOp, ctx: DispatchContext): Promise<void> {
  const channel = getSendableChannel(ctx);
  if (!channel) return;
  await channel.sendTyping();
  const wait = Math.min(Math.max(op.duration_ms ?? 0, 0), 15_000);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function fetchMessage(ctx: ReplyDispatchContext, id: string): Promise<Message | null> {
  const channel = getSendableChannelFromReplyCtx(ctx);
  if (!channel) return null;
  try {
    return await channel.messages.fetch(id);
  } catch (err) {
    (ctx.logError ?? defaultLogError)(`[discord] fetch message ${id} failed`, err);
    return null;
  }
}

/**
 * Channel objects we know how to send to. discord.js v14 exposes `channel.isSendable()`
 * which narrows away `PartialGroupDMChannel` (no `.send`) and similar edge cases.
 */
export type SendableChannel = {
  send: (payload: MessageCreateOptions | string) => Promise<Message>;
  sendTyping: () => Promise<void>;
  messages: { fetch: (id: string) => Promise<Message> };
};

function getSendableChannel(ctx: DispatchContext): SendableChannel | null {
  if (ctx.kind === 'reply') return getSendableChannelFromReplyCtx(ctx);
  return assertSendable(ctx.channel);
}

function getSendableChannelFromReplyCtx(ctx: ReplyDispatchContext): SendableChannel | null {
  return assertSendable(ctx.message.channel);
}

function assertSendable(channelRaw: unknown): SendableChannel | null {
  const channel = channelRaw as {
    isSendable?: () => boolean;
    send?: unknown;
    sendTyping?: unknown;
    messages?: { fetch?: unknown };
  };
  if (typeof channel.isSendable === 'function' && !channel.isSendable()) return null;
  if (typeof channel.send !== 'function') return null;
  if (typeof channel.sendTyping !== 'function') return null;
  if (typeof channel.messages?.fetch !== 'function') return null;
  return channel as unknown as SendableChannel;
}

function defaultAttachmentName(url: string, kind: 'image' | 'file'): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').pop();
    if (last && last.includes('.')) return last;
  } catch {
    /* ignore */
  }
  return kind === 'image' ? 'image.png' : 'file.bin';
}

/**
 * Split a long string into chunks that fit Discord's 2000-char limit, preferring
 * newline / code-fence boundaries so formatting survives.
 */
export function splitMessageContent(input: string, limit: number = DISCORD_TEXT_LIMIT): string[] {
  if (input.length <= limit) return [input];

  const out: string[] = [];
  let remaining = input;
  let inCodeFence = false;
  let codeLang = '';

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;

    let chunk = remaining.slice(0, cut);
    let next = remaining.slice(cut).replace(/^\n/, '');

    // Track open code fences and re-open in the next chunk if needed.
    const fenceMatches = chunk.match(/```([a-zA-Z0-9_+-]*)/g) ?? [];
    for (const match of fenceMatches) {
      if (inCodeFence) {
        inCodeFence = false;
        codeLang = '';
      } else {
        inCodeFence = true;
        codeLang = match.slice(3);
      }
    }
    if (inCodeFence) {
      chunk = chunk + '\n```';
      next = '```' + (codeLang ? codeLang : '') + '\n' + next;
    }

    out.push(chunk);
    remaining = next;
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
