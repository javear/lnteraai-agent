import type { MastraDBMessage } from '@mastra/core/agent';
import { getPiiMaskChar, repeatPiiMaskChar } from './agent-redaction-normalize';

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/** Phone-like strings only — avoids bare 10–15 digit order/transaction ids. */
const PHONE_PATTERN =
  /\(\d{2,4}\)\s*\d{3,4}[-.\s]?\d{3,6}|\b0\d{8,12}\b|\+\d{8,15}\b|\b\d{3}[-.\s]\d{3,4}[-.\s]\d{3,4}\b/g;

function maskChar(): string {
  return getPiiMaskChar();
}

function maskFullToken(match: string): string {
  return repeatPiiMaskChar(match.length);
}

function maskPartialDigitRun(match: string, reveal: Set<number>): string {
  const ch = maskChar();
  return match
    .split('')
    .map((c, i) => (/\d/.test(c) ? (reveal.has(i) ? c : ch) : c))
    .join('');
}

function maskPartialSsn(match: string): string {
  const digitPositions: number[] = [];
  for (let i = 0; i < match.length; i++) {
    if (/\d/.test(match[i]!)) digitPositions.push(i);
  }
  const reveal = new Set<number>();
  for (let i = digitPositions.length - 4; i < digitPositions.length; i++) {
    if (i >= 0) reveal.add(digitPositions[i]!);
  }
  return maskPartialDigitRun(match, reveal);
}

function maskPartialCreditCard(match: string): string {
  const digitPositions: number[] = [];
  for (let i = 0; i < match.length; i++) {
    if (/\d/.test(match[i]!)) digitPositions.push(i);
  }
  const reveal = new Set<number>();
  for (let i = digitPositions.length - 4; i < digitPositions.length; i++) {
    if (i >= 0) reveal.add(digitPositions[i]!);
  }
  return maskPartialDigitRun(match, reveal);
}

function maskPartialEmail(match: string): string {
  const at = match.indexOf('@');
  if (at <= 0) return maskFullToken(match);

  const local = match.slice(0, at);
  const domain = match.slice(at + 1);
  const domainDot = domain.indexOf('.');

  const firstLocal = local[0] ?? maskChar();
  const tld = domainDot >= 0 ? domain.slice(domainDot + 1) : '';
  const maskedTld =
    tld.length > 0 ? `${tld[0]}${repeatPiiMaskChar(Math.max(0, tld.length - 1))}` : maskChar();

  return `${firstLocal}${repeatPiiMaskChar(3)}@${repeatPiiMaskChar(3)}.${maskedTld}`;
}

function maskPartialPhone(match: string): string {
  const digitPositions: number[] = [];
  for (let i = 0; i < match.length; i++) {
    if (/\d/.test(match[i]!)) digitPositions.push(i);
  }
  if (digitPositions.length < 7) return maskFullToken(match);

  const reveal = new Set<number>();
  for (let i = 0; i < Math.min(2, digitPositions.length); i++) {
    reveal.add(digitPositions[i]!);
  }
  for (let i = digitPositions.length - 4; i < digitPositions.length; i++) {
    if (i >= 0) reveal.add(digitPositions[i]!);
  }

  return maskPartialDigitRun(match, reveal);
}

function replaceAll(text: string, pattern: RegExp, replacer: (match: string) => string): string {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return text.replace(re, (match) => replacer(match));
}

export function applyPartialPiiMask(text: string): string {
  let out = text;
  out = replaceAll(out, SSN_PATTERN, maskPartialSsn);
  out = replaceAll(out, CREDIT_CARD_PATTERN, maskPartialCreditCard);
  out = replaceAll(out, EMAIL_PATTERN, maskPartialEmail);
  out = replaceAll(out, PHONE_PATTERN, maskPartialPhone);
  return out;
}

export function applyFullPiiMask(text: string): string {
  let out = text;
  out = replaceAll(out, SSN_PATTERN, maskFullToken);
  out = replaceAll(out, CREDIT_CARD_PATTERN, maskFullToken);
  out = replaceAll(out, EMAIL_PATTERN, maskFullToken);
  out = replaceAll(out, PHONE_PATTERN, maskFullToken);
  return out;
}

export function applyPiiMask(text: string, mode: 'partial' | 'full'): string {
  return mode === 'partial' ? applyPartialPiiMask(text) : applyFullPiiMask(text);
}

export function applyPiiMaskToMessage(message: MastraDBMessage, mode: 'partial' | 'full'): void {
  const content = message.content;
  if (!content || typeof content !== 'object') return;

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const textPart = part as { type: 'text'; text: string };
        if (typeof textPart.text === 'string') {
          textPart.text = applyPiiMask(textPart.text, mode);
        }
      }
    }
  }

  if ('content' in content && typeof (content as { content?: unknown }).content === 'string') {
    (content as { content: string }).content = applyPiiMask(
      (content as { content: string }).content,
      mode,
    );
  }
}
