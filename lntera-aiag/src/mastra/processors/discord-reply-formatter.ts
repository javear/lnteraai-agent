import type { Processor, ProcessOutputStreamArgs } from '@mastra/core/processors';
import { StructuredOutputProcessor } from '@mastra/core/processors';
import type { Mastra } from '@mastra/core/mastra';
import type { ChunkType } from '@mastra/core/stream';
import { discordReplySchema, type DiscordReply } from '../integrations/discord/reply-schema';

/** Default Groq model for the formatting pass (no tools; JSON via prompt injection). */
const DEFAULT_DISCORD_FORMAT_MODEL =
  process.env.DISCORD_FORMAT_MODEL?.trim() || 'groq/llama-3.1-8b-instant';

const DISCORD_FORMATTER_INSTRUCTIONS = `You format assistant replies for Discord delivery.

Input is the assistant's final answer after any tool calls (text, tool results, reasoning). Produce a single JSON object with an "ops" array.

Rules:
- Prefer 1–3 ops. Use "text" for normal replies (markdown allowed, max 2000 chars per op).
- Do not use markdown tables — Discord cannot render them. Use bullet lists, numbered lines, or an embed with fields for tabular data (orders, products).
- Use "embed" for orders, products, or shipments (title, description, optional fields).
- Use "reaction" only with a valid "to_message_id" when a single emoji acknowledgment is enough.
- Use "image" or "file" only when the input includes a real URL from a tool result.
- Use "noop" when no user-visible reply is needed.
- Never invent URLs or message ids. Omit "to_message_id" unless replying to a specific message id present in the input.
- Do not call tools. Output only the JSON object matching the schema.`;

/**
 * Second-stage formatter for Discord: runs after the main agent (with tools) finishes.
 * Uses Mastra's StructuredOutputProcessor internally so Groq never gets json mode + tools
 * on the same request.
 *
 * Only active when requestContext.channel === "discord".
 */
function createInnerFormatter(): StructuredOutputProcessor<DiscordReply> {
  return new StructuredOutputProcessor({
    schema: discordReplySchema,
    model: DEFAULT_DISCORD_FORMAT_MODEL,
    jsonPromptInjection: true,
    instructions: DISCORD_FORMATTER_INSTRUCTIONS,
    errorStrategy: 'fallback',
    fallbackValue: {
      ops: [
        {
          message_type: 'text',
          content: 'Sorry, I had trouble formatting that response for Discord.',
        },
      ],
    },
  });
}

let innerFormatter: StructuredOutputProcessor<DiscordReply> | null = null;

function getInnerFormatter(): StructuredOutputProcessor<DiscordReply> {
  if (!innerFormatter) {
    innerFormatter = createInnerFormatter();
  }
  return innerFormatter;
}

type DiscordReplyRepairResult =
  | { success: true; data: DiscordReply; repaired: boolean }
  | { success: false; error: unknown };

/**
 * Best-effort parser for LLM-produced Discord reply JSON.
 *
 * Handles common model slips before Zod validation:
 * - fenced JSON blocks
 * - explanatory text around the JSON
 * - single quotes / trailing commas / unquoted keys (via jsonrepair)
 * - accidentally returning an ops array directly
 */
export function parseDiscordReplyFromUnknown(candidate: unknown): DiscordReplyRepairResult {
  if (looksLikeJsonSchema(candidate)) {
    return {
      success: false,
      error: new Error('Formatter returned a JSON Schema instead of a Discord reply object'),
    };
  }

  const direct = discordReplySchema.safeParse(candidate);
  if (direct.success) {
    return { success: true, data: direct.data, repaired: false };
  }

  if (Array.isArray(candidate)) {
    const parsedArray = discordReplySchema.safeParse({ ops: candidate });
    if (parsedArray.success) {
      return { success: true, data: parsedArray.data, repaired: true };
    }
  }

  const text = stringifyCandidate(candidate);
  if (!text) return { success: false, error: direct.error };

  for (const raw of extractJsonCandidates(text)) {
    const parsed = parsePotentialJson(raw);
    if (parsed === undefined) continue;
    if (looksLikeJsonSchema(parsed)) {
      return {
        success: false,
        error: new Error('Formatter returned a JSON Schema instead of a Discord reply object'),
      };
    }

    const repaired = discordReplySchema.safeParse(Array.isArray(parsed) ? { ops: parsed } : parsed);
    if (repaired.success) {
      return { success: true, data: repaired.data, repaired: true };
    }
  }

  return { success: false, error: direct.error };
}

function looksLikeJsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    ('$schema' in obj || obj.type === 'object') &&
    'properties' in obj &&
    'required' in obj &&
    !('ops' in obj && Array.isArray(obj.ops))
  );
}

function stringifyCandidate(candidate: unknown): string {
  if (typeof candidate === 'string') return candidate.trim();
  if (candidate == null) return '';
  try {
    return JSON.stringify(candidate);
  } catch {
    return String(candidate);
  }
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenced)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  const objectSlice = sliceBalancedJson(text, '{', '}');
  if (objectSlice) candidates.push(objectSlice);

  const arraySlice = sliceBalancedJson(text, '[', ']');
  if (arraySlice) candidates.push(arraySlice);

  if (text.trim()) candidates.push(text.trim());
  return [...new Set(candidates)];
}

function sliceBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    if (ch === close) depth -= 1;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function parsePotentialJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(repairCommonJsonIssues(raw));
    } catch {
      return undefined;
    }
  }
}

/**
 * Tiny repair pass for common LLM JSON mistakes. This is intentionally conservative:
 * if repair still does not parse + validate, callers fall back to safe text.
 */
function repairCommonJsonIssues(raw: string): string {
  let out = raw.trim();

  // Strip markdown fence language if a caller passed the full fence content.
  out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Quote unquoted object keys: { ops: [...] } -> { "ops": [...] }
  out = out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // Convert single-quoted strings to double-quoted strings.
  out = out.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, body: string) => {
    return `"${body.replace(/"/g, '\\"')}"`;
  });

  // Remove trailing commas before object/array close.
  out = out.replace(/,\s*([}\]])/g, '$1');

  // Balance accidentally truncated object/array wrappers.
  const openCurly = (out.match(/{/g) ?? []).length;
  const closeCurly = (out.match(/}/g) ?? []).length;
  const openSquare = (out.match(/\[/g) ?? []).length;
  const closeSquare = (out.match(/\]/g) ?? []).length;
  if (closeSquare < openSquare) out += ']'.repeat(openSquare - closeSquare);
  if (closeCurly < openCurly) out += '}'.repeat(openCurly - closeCurly);

  return out;
}

export const discordReplyFormatterProcessor = {
  id: 'discord-reply-formatter',
  name: 'Discord Reply Formatter',

  __registerMastra(mastra: Mastra): void {
    getInnerFormatter().__registerMastra(mastra);
  },

  async processOutputStream(
    args: ProcessOutputStreamArgs,
  ): Promise<ChunkType | null | undefined> {
    if (args.requestContext?.get('channel') !== 'discord') {
      return args.part;
    }
    return getInnerFormatter().processOutputStream(args);
  },
} satisfies Processor<'discord-reply-formatter'>;
