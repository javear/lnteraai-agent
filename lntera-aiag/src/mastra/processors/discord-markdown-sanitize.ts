import type { MastraDBMessage } from '@mastra/core/agent';
import type { ChunkType } from '@mastra/core/stream';
import type {
  OutputProcessor,
  ProcessOutputResultArgs,
  ProcessOutputStreamArgs,
} from '@mastra/core/processors';

function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const cells = t.replace(/^\||\|$/g, '').split('|');
  return cells.length >= 2 && cells.some((c) => c.trim().length > 0);
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function convertTableBlock(lines: string[]): string {
  if (lines.length === 0) return '';

  const headerCells = parseTableCells(lines[0]!);
  const bodyLines = lines.slice(1).filter((line) => !isTableSeparatorLine(line));

  const bullets = bodyLines.map((line) => {
    const cells = parseTableCells(line);
    if (cells.every((c) => c.length === 0)) return null;

    if (headerCells.length === cells.length && headerCells.length > 1) {
      const first = cells[0] ?? '';
      const rest = cells
        .slice(1)
        .map((cell, i) => `${headerCells[i + 1]}: ${cell}`)
        .join(' · ');
      return rest.length > 0 ? `• **${first}** — ${rest}` : `• **${first}**`;
    }

    return `• ${cells.filter(Boolean).join(' · ')}`;
  });

  return bullets.filter((b): b is string => b != null).join('\n');
}

/** Converts GitHub-style markdown tables to Discord-friendly bullet lists. */
export function sanitizeMarkdownTablesForDiscord(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    if (tableBuffer.length >= 2 && tableBuffer.every(isTableRow)) {
      out.push(convertTableBlock(tableBuffer));
    } else {
      out.push(...tableBuffer);
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    out.push(line);
  }

  flushTable();
  return out.join('\n');
}

function sanitizeText(text: string): string {
  return sanitizeMarkdownTablesForDiscord(text);
}

function sanitizeMessage(message: MastraDBMessage): void {
  const content = message.content;
  if (!content || typeof content !== 'object') return;

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const textPart = part as { type: 'text'; text: string };
        if (typeof textPart.text === 'string') {
          textPart.text = sanitizeText(textPart.text);
        }
      }
    }
  }

  if ('content' in content && typeof (content as { content?: unknown }).content === 'string') {
    (content as { content: string }).content = sanitizeText(
      (content as { content: string }).content,
    );
  }
}

export function createDiscordMarkdownSanitizeProcessor(): OutputProcessor {
  return {
    id: 'discord-markdown-sanitize',
    name: 'Discord markdown sanitize (tables → bullets)',

    async processOutputStream(args: ProcessOutputStreamArgs) {
      if (args.requestContext?.get?.('channel') !== 'discord') return args.part;

      const part = args.part;
      if (!part || part.type !== 'text-delta') return part;
      const payload = part.payload;
      if (!payload || typeof payload.text !== 'string') return part;

      return {
        ...part,
        payload: {
          ...payload,
          text: sanitizeText(payload.text),
        },
      };
    },

    async processOutputResult(args: ProcessOutputResultArgs) {
      if (args.requestContext?.get?.('channel') !== 'discord') return args.messages;

      for (const message of args.messages) {
        if (message.role === 'assistant') sanitizeMessage(message);
      }
      return args.messages;
    },
  };
}

export const discordMarkdownSanitizeProcessor = createDiscordMarkdownSanitizeProcessor();
