import { GROQ_TOOL_MODELS } from '../models/groq-tool-models';

const GLOBAL_TENANT_KEY = '__global__';

type CacheEntry = {
  expiresAt: number;
};

/** tenantId + normalized model code → cooldown expiry (ms epoch). */
const rateLimitUntil = new Map<string, CacheEntry>();

/** Normalize `groq/qwen/qwen3-32b` and `qwen/qwen3-32b` to the same cache key segment. */
export function normalizeGroqModelCode(identity: string): string {
  const trimmed = identity.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('groq/') ? trimmed.slice('groq/'.length) : trimmed;
}

function cacheKey(tenantId: string, modelCode: string): string {
  return `${tenantId}:${normalizeGroqModelCode(modelCode)}`;
}

function resolveTenantId(tenantId: string | null | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : GLOBAL_TENANT_KEY;
}

/**
 * Parse Groq `x-ratelimit-reset-tokens` (e.g. `34.919s`, `2m52.8s`) to milliseconds.
 */
export function parseGroqResetTokensHeader(header: string | undefined): number | null {
  if (!header?.trim()) return null;
  const value = header.trim();

  const secondsOnly = /^([\d.]+)s$/i.exec(value);
  if (secondsOnly) {
    const sec = parseFloat(secondsOnly[1]);
    return Number.isFinite(sec) ? Math.ceil(sec * 1000) : null;
  }

  const minutesSeconds = /^(\d+)m([\d.]+)s$/i.exec(value);
  if (minutesSeconds) {
    const min = parseInt(minutesSeconds[1], 10);
    const sec = parseFloat(minutesSeconds[2]);
    if (Number.isFinite(min) && Number.isFinite(sec)) {
      return Math.ceil((min * 60 + sec) * 1000);
    }
  }

  return null;
}

export function markGroqModelRateLimited(
  tenantId: string | null | undefined,
  modelCode: string,
  ttlMs: number,
): void {
  const norm = normalizeGroqModelCode(modelCode);
  if (!norm || ttlMs <= 0) return;
  const key = cacheKey(resolveTenantId(tenantId), norm);
  const expiresAt = Date.now() + ttlMs;
  const existing = rateLimitUntil.get(key);
  if (!existing || expiresAt > existing.expiresAt) {
    rateLimitUntil.set(key, { expiresAt });
  }
}

export function isGroqModelRateLimited(
  tenantId: string | null | undefined,
  modelCode: string,
): boolean {
  const norm = normalizeGroqModelCode(modelCode);
  if (!norm) return false;
  const key = cacheKey(resolveTenantId(tenantId), norm);
  const entry = rateLimitUntil.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    rateLimitUntil.delete(key);
    return false;
  }
  return true;
}

/** First candidate in `GROQ_TOOL_MODELS` order that is not rate-limited for this tenant. */
export function pickGroqModelSkippingRateLimited(args: {
  tenantId: string | null | undefined;
  currentIdentity: string;
  candidates?: readonly string[];
}): string | null {
  const { tenantId, currentIdentity } = args;
  const candidates = args.candidates ?? GROQ_TOOL_MODELS;
  const currentNorm = normalizeGroqModelCode(currentIdentity);

  if (!isGroqModelRateLimited(tenantId, currentNorm)) {
    return null;
  }

  for (const model of candidates) {
    const norm = normalizeGroqModelCode(model);
    if (norm === currentNorm) continue;
    if (!isGroqModelRateLimited(tenantId, norm)) {
      return model;
    }
  }

  return null;
}

const RATE_LIMIT_MESSAGE = /rate limit reached/i;
const REQUEST_TOO_LARGE_MESSAGE =
  /request too large|reduce your message size|tokens per minute \(tpm\).*requested/i;
const MODEL_IN_RATE_LIMIT_MESSAGE = /model [`']([^'`]+)[`']/i;
const TRY_AGAIN_IN_SECONDS = /try again in ([\d.]+)s/i;

/** Groq on-demand TPM per request for llama-3.1-8b-instant is often 6000 — stay well under. */
export const GROQ_SMALL_MODEL_TPM_LIMIT = 6_000;

export function extractGroqRateLimitFromError(
  error: unknown,
  fallbackModelIdentity?: string,
): { modelCode: string; ttlMs: number } | null {
  if (error == null) return null;

  const err = error as Record<string, unknown>;
  const statusCode = err.statusCode ?? err.status;
  const message =
    error instanceof Error
      ? error.message
      : typeof err.message === 'string'
        ? err.message
        : '';

  const is429 = statusCode === 429;
  const isOversize = REQUEST_TOO_LARGE_MESSAGE.test(message);
  if (!is429 && !RATE_LIMIT_MESSAGE.test(message) && !isOversize) {
    return null;
  }

  const headers = err.responseHeaders as Record<string, string | number> | undefined;
  const resetHeader =
    (headers && (headers['x-ratelimit-reset-tokens'] ?? headers['X-Ratelimit-Reset-Tokens'])) ??
    undefined;
  const resetStr = typeof resetHeader === 'string' ? resetHeader : undefined;

  let ttlMs = parseGroqResetTokensHeader(resetStr);
  if (ttlMs == null && headers) {
    const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
    const sec = typeof retryAfter === 'string' ? parseInt(retryAfter, 10) : Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) {
      ttlMs = sec * 1000;
    }
  }
  if (ttlMs == null) {
    const fromBody = TRY_AGAIN_IN_SECONDS.exec(message)?.[1];
    if (fromBody) {
      const sec = parseFloat(fromBody);
      if (Number.isFinite(sec) && sec > 0) {
        ttlMs = Math.ceil(sec * 1000);
      }
    }
  }
  if (ttlMs == null) {
    // Oversize / TPM rejections: avoid hammering the same small model for ~2 minutes.
    ttlMs = isOversize ? 120_000 : 60_000;
  }

  const fromMessage = MODEL_IN_RATE_LIMIT_MESSAGE.exec(message)?.[1];
  const modelCode =
    (fromMessage && normalizeGroqModelCode(fromMessage)) ||
    (fallbackModelIdentity && normalizeGroqModelCode(fallbackModelIdentity)) ||
    '';

  if (!modelCode) return null;

  return { modelCode, ttlMs };
}
