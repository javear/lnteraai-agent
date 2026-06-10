import type { MastraDBMessage } from '@mastra/core/agent';
import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';
import { getDiscordAmbientRecallLimit } from '../agents/agent-memory-config';

const AMBIENT_PREFIX = '[Recent channel activity — not directed at bot] ';

type DiscordMessageMeta = {
  isMention?: boolean;
  isDM?: boolean;
};

function readDiscordMeta(message: MastraDBMessage): DiscordMessageMeta | null {
  const content = message.content;
  if (!content || typeof content !== 'object') return null;
  const metadata = (content as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const channel = (metadata as { channel?: unknown }).channel;
  if (channel !== 'discord') return null;
  const discord = (metadata as { discord?: unknown }).discord;
  if (!discord || typeof discord !== 'object') return { isMention: false, isDM: false };
  const d = discord as { isMention?: unknown; isDM?: unknown };
  return {
    isMention: d.isMention === true,
    isDM: d.isDM === true,
  };
}

function isAmbientUserMessage(message: MastraDBMessage): boolean {
  if (message.role !== 'user') return false;
  const meta = readDiscordMeta(message);
  if (!meta) return false;
  return !meta.isMention && !meta.isDM;
}

function prefixAmbientMessageText(message: MastraDBMessage): void {
  const content = message.content;
  if (!content || typeof content !== 'object' || !Array.isArray(content.parts)) return;
  for (const part of content.parts) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const textPart = part as { type: 'text'; text: string };
      if (!textPart.text.startsWith(AMBIENT_PREFIX)) {
        textPart.text = `${AMBIENT_PREFIX}${textPart.text}`;
      }
      return;
    }
  }
}

/**
 * Discord-only: keep all assistant + directed user turns; cap ambient (non-mention) user messages.
 * Ambient rows remain in storage — only recalled context is trimmed before the LLM call.
 */
export function filterDiscordMemoryMessages(
  messages: MastraDBMessage[],
  ambientLimit: number,
): MastraDBMessage[] {
  const ambientIndices: number[] = [];
  const keep = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'assistant') {
      keep.add(i);
      continue;
    }
    if (msg.role !== 'user') {
      keep.add(i);
      continue;
    }
    const meta = readDiscordMeta(msg);
    if (!meta) {
      keep.add(i);
      continue;
    }
    if (meta.isMention || meta.isDM) {
      keep.add(i);
      continue;
    }
    ambientIndices.push(i);
  }

  const keptAmbient = ambientIndices.slice(-ambientLimit);
  for (const idx of keptAmbient) {
    keep.add(idx);
    prefixAmbientMessageText(messages[idx]!);
  }

  return messages.filter((_, i) => keep.has(i));
}

export const discordMemoryRecallProcessor = {
  id: 'discord-memory-recall',
  name: 'Discord ambient memory recall filter',

  processInputStep(args: ProcessInputStepArgs): void {
    if (args.requestContext?.get?.('channel') !== 'discord') return;
    if (!args.messageList) return;

    const messages = args.messageList.get.all.db();
    if (!messages.length) return;

    const filtered = filterDiscordMemoryMessages(messages, getDiscordAmbientRecallLimit());
    const keepIds = new Set(filtered.map((m) => m.id));
    const removeIds = messages.filter((m) => !keepIds.has(m.id)).map((m) => m.id);
    if (removeIds.length > 0) {
      args.messageList.removeByIds(removeIds);
    }
  },
} satisfies Processor<'discord-memory-recall'>;
