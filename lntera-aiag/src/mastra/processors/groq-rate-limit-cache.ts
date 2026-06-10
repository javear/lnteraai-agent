import { GROQ_TOOL_MODELS } from '../models/groq-tool-models';
import { providerCodeForSegment, splitModelCode } from '../models/llm-providers';

const GLOBAL_TENANT_KEY = '__global__';

type CacheEntry = {
  expiresAt: number;
};

/** tenantId + normalized model code → cooldown expiry (ms epoch). */
const rateLimitUntil = new Map<string, CacheEntry>();

/**
 * Normalize any model identity to a provider-qualified cache key (`${provider}/${segment}`):
 *   `qwen/qwen3-32b` → `groq/qwen/qwen3-32b`, `gemini-2.0-flash` → `gemini/gemini-2.0-flash`.
 * Keeping the provider prefix means Groq and Gemini models never share a cooldown bucket.
 */
export function normalizeGroqModelCode(identity: string): string {
  const trimmed = identity.trim().toLowerCase();
  if (!trimmed) return '';
  // Already provider-qualified (groq/…, gemini/…) → keep as-is.
  if (splitModelCode(trimmed)) return trimmed;
  // Bare Portkey segment → qualify via the registry, defaulting to groq for back-compat.
  const provider = providerCodeForSegment(trimmed) ?? 'groq';
  return `${provider}/${trimmed}`;
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

// ── Per-model token ceiling (max tokens a single request may use) ───────────────────────────
// Learned from oversize errors (`… Limit 6000, Requested 11077`) so we route large requests to a
// model that can actually take them, instead of repeatedly hitting a low-TPM model. Self-correcting:
// learned values override the coarse priors, so nothing here goes stale the way hardcoded TPM would.

const TOKEN_CEILING_TTL_MS = 30 * 60_000;
type CeilingEntry = { limitTokens: number; expiresAt: number };
const modelTokenCeiling = new Map<string, CeilingEntry>();

/** Coarse bootstrap priors for Groq free `on_demand` per-request token capacity (≈ TPM). */
const MODEL_TOKEN_CEILING_PRIOR: Readonly<Record<string, number>> = {
  'groq/llama-3.1-8b-instant': 6_000,
  'groq/qwen/qwen3-32b': 6_000,
  'groq/openai/gpt-oss-20b': 8_000,
  'groq/openai/gpt-oss-120b': 8_000,
  'groq/llama-3.3-70b-versatile': 12_000,
  'groq/meta-llama/llama-4-scout-17b-16e-instruct': 12_000,
};
/** Non-Groq providers (Gemini) have very large token limits — treat as effectively unbounded. */
const LARGE_MODEL_TOKEN_CEILING = 1_000_000;

/** Record a model's observed per-request token ceiling (the `Limit N` from an oversize error). */
export function markModelTokenCeiling(
  tenantId: string | null | undefined,
  modelCode: string,
  limitTokens: number,
): void {
  const norm = normalizeGroqModelCode(modelCode);
  if (!norm || !Number.isFinite(limitTokens) || limitTokens <= 0) return;
  modelTokenCeiling.set(cacheKey(resolveTenantId(tenantId), norm), {
    limitTokens,
    expiresAt: Date.now() + TOKEN_CEILING_TTL_MS,
  });
}

/**
 * Effective per-request token ceiling for a model: the learned value if known, else a coarse prior.
 * Non-Groq providers (Gemini) → large. Returns `null` when truly unknown (caller treats as "fits").
 */
export function getModelTokenCeiling(
  tenantId: string | null | undefined,
  modelCode: string,
): number | null {
  const norm = normalizeGroqModelCode(modelCode);
  if (!norm) return null;
  const key = cacheKey(resolveTenantId(tenantId), norm);
  const entry = modelTokenCeiling.get(key);
  if (entry) {
    if (Date.now() < entry.expiresAt) return entry.limitTokens;
    modelTokenCeiling.delete(key);
  }
  if (norm in MODEL_TOKEN_CEILING_PRIOR) return MODEL_TOKEN_CEILING_PRIOR[norm];
  const code = splitModelCode(norm)?.code;
  if (code && code !== 'groq') return LARGE_MODEL_TOKEN_CEILING;
  return null;
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

const RATE_LIMIT_MESSAGE = /rate limit reached|resource_exhausted|exceeded your current quota/i;
const REQUEST_TOO_LARGE_MESSAGE =
  /request too large|reduce your message size|tokens per minute \(tpm\).*requested/i;
const MODEL_IN_RATE_LIMIT_MESSAGE = /model [`']([^'`]+)[`']/i;
/** Google's 429 body names the model unquoted, e.g. `… model: gemini-2.5-flash`. */
const MODEL_UNQUOTED = /\bmodel:\s*([\w.-]+)/i;
const TRY_AGAIN_IN_SECONDS = /try again in ([\d.]+)s/i;
/** Oversize errors state the model's per-request cap + the attempted size: `Limit 6000, Requested 11077`. */
const OVERSIZE_LIMIT_TOKENS = /limit\s+([\d,]+)/i;
const OVERSIZE_REQUESTED_TOKENS = /requested\s+([\d,]+)/i;
/** Google hints the cooldown via `Please retry in 13.6s` and/or `"retryDelay":"13s"`. */
const GOOGLE_RETRY_IN_SECONDS = /retry in ([\d.]+)s/i;
const GOOGLE_RETRY_DELAY = /"?retryDelay"?\s*:\s*"?([\d.]+)s/i;

/** First seconds-based cooldown hint found in a provider error body, in ms (Groq + Google formats). */
function extractRetrySecondsMs(message: string): number | null {
  for (const re of [TRY_AGAIN_IN_SECONDS, GOOGLE_RETRY_IN_SECONDS, GOOGLE_RETRY_DELAY]) {
    const sec = re.exec(message)?.[1];
    if (sec) {
      const n = parseFloat(sec);
      if (Number.isFinite(n) && n > 0) return Math.ceil(n * 1000);
    }
  }
  return null;
}

/** Groq on-demand TPM per request for llama-3.1-8b-instant is often 6000 — stay well under. */
export const GROQ_SMALL_MODEL_TPM_LIMIT = 6_000;

export function extractGroqRateLimitFromError(
  error: unknown,
  fallbackModelIdentity?: string,
): { modelCode: string; ttlMs: number; limitTokens?: number; requestedTokens?: number } | null {
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
    ttlMs = extractRetrySecondsMs(message);
  }
  if (ttlMs == null) {
    // Oversize is size-based, not a sustained block — a short cooldown is enough; the learned token
    // ceiling (below) is what actually keeps large requests off this model. Pure TPM → 60s.
    ttlMs = isOversize ? 30_000 : 60_000;
  }

  const fromMessage = MODEL_IN_RATE_LIMIT_MESSAGE.exec(message)?.[1] ?? MODEL_UNQUOTED.exec(message)?.[1];
  const modelCode =
    (fromMessage && normalizeGroqModelCode(fromMessage)) ||
    (fallbackModelIdentity && normalizeGroqModelCode(fallbackModelIdentity)) ||
    '';

  if (!modelCode) return null;

  // On oversize, capture the model's per-request token ceiling (`Limit N`) and the attempted size
  // (`Requested N`) for size-aware routing.
  let limitTokens: number | undefined;
  let requestedTokens: number | undefined;
  if (isOversize) {
    const parseNum = (re: RegExp): number | undefined => {
      const raw = re.exec(message)?.[1]?.replace(/,/g, '');
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    limitTokens = parseNum(OVERSIZE_LIMIT_TOKENS);
    requestedTokens = parseNum(OVERSIZE_REQUESTED_TOKENS);
  }

  return {
    modelCode,
    ttlMs,
    ...(limitTokens ? { limitTokens } : {}),
    ...(requestedTokens ? { requestedTokens } : {}),
  };
}
