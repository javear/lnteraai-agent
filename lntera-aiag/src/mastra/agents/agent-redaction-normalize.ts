import type { MastraDBMessage } from '@mastra/core/agent';
import type { ChunkType } from '@mastra/core/stream';

/** Default mask char — middle dot; safe in Discord markdown (unlike `*`). */
const DEFAULT_PII_MASK_CHAR = '·';

/** Single character used for PII/secret redaction. Override via REGEX_PII_MASK_CHAR. */
export function getPiiMaskChar(): string {
  const raw = process.env.REGEX_PII_MASK_CHAR?.trim();
  if (raw && raw.length > 0) {
    return [...raw][0]!;
  }
  return DEFAULT_PII_MASK_CHAR;
}

export function repeatPiiMaskChar(count: number): string {
  if (count <= 0) return '';
  return getPiiMaskChar().repeat(count);
}

/** Fixed-width redaction blob for secrets / leak regex rules. */
export function getRedactionMarker(): string {
  return repeatPiiMaskChar(4);
}

/** @deprecated Use getRedactionMarker() — kept for imports that expect a string constant. */
export const REDACTION_MARKER = '****';

/** Mastra / LLM bracket placeholders → current redaction marker. */
const BRACKET_REDACTION =
  /\[(?:REDACTED(?:_MATCH)?|SYSTEM_PROMPT|EMAIL|PHONE|SSN|CREDIT_CARD|API_KEY|BEARER_TOKEN|AWS_KEY|URL|FILTERED)\]/gi;

export function normalizeRedactionText(text: string): string {
  return text.replace(BRACKET_REDACTION, getRedactionMarker());
}

export function normalizeRedactionInMessages(messages: MastraDBMessage[]): MastraDBMessage[] {
  for (const message of messages) {
    normalizeRedactionInMessage(message);
  }
  return messages;
}

export function normalizeRedactionInMessage(message: MastraDBMessage): void {
  const content = message.content;
  if (!content || typeof content !== 'object') return;
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const textPart = part as { type: 'text'; text: string };
        if (typeof textPart.text === 'string') {
          textPart.text = normalizeRedactionText(textPart.text);
        }
      }
    }
  }
  if ('content' in content && typeof (content as { content?: unknown }).content === 'string') {
    (content as { content: string }).content = normalizeRedactionText(
      (content as { content: string }).content,
    );
  }
}

export function normalizeRedactionStreamPart(part: ChunkType): ChunkType {
  if (part.type !== 'text-delta') return part;
  const payload = part.payload;
  if (!payload || typeof payload.text !== 'string') return part;
  return {
    ...part,
    payload: {
      ...payload,
      text: normalizeRedactionText(payload.text),
    },
  };
}
