import { GROQ_TOOL_MODELS } from './groq-tool-models';

/**
 * Registry of BYO LLM providers connected per-tenant via Portkey.
 *
 * Adding a provider is intentionally cheap: append an entry here (models, key validator,
 * console URL) and it flows through provisioning, the rolling chain, the rate-limiter, the
 * connect dialog, and the chat model label without touching the rest of the stack.
 *
 * Identity scheme used everywhere downstream:
 *   - **segment**   — the Portkey model name (the part after `@{slug}/`), e.g. `gemini-2.0-flash`
 *                     or `meta-llama/llama-4-scout-17b-16e-instruct` (segments may contain `/`).
 *   - **modelCode** — `${providerCode}/${segment}` (e.g. `gemini/gemini-2.0-flash`,
 *                     `groq/llama-3.3-70b-versatile`). Provider-qualified so two providers never
 *                     collide in the rate-limit cache or the chain.
 */
export const LLM_PROVIDER_CODES = ['groq', 'gemini'] as const;
export type LlmProviderCode = (typeof LLM_PROVIDER_CODES)[number];

export interface LlmProviderDef {
  code: LlmProviderCode;
  /** Human label used in the UI and the chat "Provider · model" tag. */
  displayName: string;
  /** Portkey `ai_provider_id` for the integration (key store). */
  portkeyAiProviderId: string;
  /** Portkey model segments (after `@{slug}/`). Tool-capable chat models only. */
  toolModels: readonly string[];
  /** Segments preferred first when the turn is large (tools + history). */
  largeContextPreferred: readonly string[];
  /** Segments treated as small-context (deprioritized on large turns). */
  smallModels: readonly string[];
  /** Segment used for the connect-time validation chat completion. */
  validationModel: string;
  /** Cheap shape check of a pasted API key (full validation happens via Portkey). */
  validateKey: (key: string) => boolean;
  /** Placeholder/hint shown in the connect dialog (e.g. `gsk_…`). */
  keyHint: string;
  /** Where the user creates a free key. */
  consoleUrl: string;
  consoleLabel: string;
}

/** GROQ_TOOL_MODELS are stored as `groq/<segment>`; strip the prefix to get Portkey segments. */
const GROQ_SEGMENTS = GROQ_TOOL_MODELS.map((m) => m.replace(/^groq\//, ''));

export const LLM_PROVIDERS: Record<LlmProviderCode, LlmProviderDef> = {
  groq: {
    code: 'groq',
    displayName: 'Groq',
    portkeyAiProviderId: 'groq',
    toolModels: GROQ_SEGMENTS,
    largeContextPreferred: [
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
    ],
    smallModels: ['llama-3.1-8b-instant'],
    validationModel: 'llama-3.1-8b-instant',
    validateKey: (key) => {
      const v = key.trim();
      return v.startsWith('gsk_') && v.length >= 20;
    },
    keyHint: 'gsk_…',
    consoleUrl: 'https://console.groq.com/keys',
    consoleLabel: 'Groq Console',
  },
  gemini: {
    code: 'gemini',
    displayName: 'Gemini',
    portkeyAiProviderId: 'google',
    // Current GA, free-tier, tool-capable Gemini chat models (June 2026). The 2.0 family was shut
    // down 2026-06-01 and Pro has no free tier, so we roll across the live flash + flash-lite models.
    toolModels: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    largeContextPreferred: ['gemini-3.5-flash', 'gemini-2.5-flash'],
    smallModels: ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
    validationModel: 'gemini-2.5-flash-lite',
    validateKey: (key) => {
      const v = key.trim();
      // Google AI Studio issues both the legacy `AIza…` keys and the newer `AQ.…` keys.
      return (v.startsWith('AIza') || v.startsWith('AQ.')) && v.length >= 14;
    },
    keyHint: 'AIza… or AQ.…',
    consoleUrl: 'https://aistudio.google.com/apikey',
    consoleLabel: 'Google AI Studio',
  },
};

export function isLlmProviderCode(value: string): value is LlmProviderCode {
  return (LLM_PROVIDER_CODES as readonly string[]).includes(value);
}

export function getLlmProvider(code: string): LlmProviderDef | null {
  return isLlmProviderCode(code) ? LLM_PROVIDERS[code] : null;
}

/** Build a provider-qualified model code, tolerating an already-prefixed segment. */
export function toModelCode(code: LlmProviderCode, segment: string): string {
  const seg = segment.replace(new RegExp(`^${code}/`), '');
  return `${code}/${seg}`;
}

/** Split a `${provider}/${segment}` code; returns null when the prefix is not a known provider. */
export function splitModelCode(modelCode: string): { code: LlmProviderCode; segment: string } | null {
  const trimmed = modelCode.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const prefix = trimmed.slice(0, slash).toLowerCase();
  if (!isLlmProviderCode(prefix)) return null;
  return { code: prefix, segment: trimmed.slice(slash + 1) };
}

// Reverse map: Portkey segment (lowercased) → provider code. Segments are globally unique.
const SEGMENT_TO_PROVIDER: ReadonlyMap<string, LlmProviderCode> = (() => {
  const m = new Map<string, LlmProviderCode>();
  for (const def of Object.values(LLM_PROVIDERS)) {
    for (const seg of def.toolModels) m.set(seg.toLowerCase(), def.code);
  }
  return m;
})();

/** Which provider owns this Portkey segment (e.g. `gemini-2.0-flash` → `gemini`). */
export function providerCodeForSegment(segment: string): LlmProviderCode | null {
  return SEGMENT_TO_PROVIDER.get(segment.trim().toLowerCase()) ?? null;
}

/** Provider code for a value that may be a qualified modelCode or a bare segment. */
export function providerCodeForModel(value: string): LlmProviderCode | null {
  return splitModelCode(value)?.code ?? providerCodeForSegment(value);
}

/** All tool model codes across every provider, as `${provider}/${segment}`. */
export function allLlmModelCodes(): string[] {
  return Object.values(LLM_PROVIDERS).flatMap((def) =>
    def.toolModels.map((seg) => toModelCode(def.code, seg)),
  );
}

/** "Provider · model" label for a model identity/segment (used by the chat UI server-side helpers). */
export function llmModelLabel(value: string): string {
  const split = splitModelCode(value);
  const segment = split ? split.segment : value.trim();
  const code = split?.code ?? providerCodeForSegment(segment);
  const provider = code ? LLM_PROVIDERS[code].displayName : 'LLM';
  return `${provider} · ${segment}`;
}
