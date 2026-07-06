import type { MastraClient } from '@mastra/client-js';
import { AGENT_ID } from './mastra';
import { browserTimezone } from './insights';

/** The user's current UI language (same localStorage key as the i18n engine) — sent to the agent so it
 *  replies in that language. Defaults to 'en' when unset/unavailable. */
function currentLang(): string {
  try {
    return localStorage.getItem('lntera-lang') || 'en';
  } catch {
    return 'en';
  }
}

/** A tool invocation the agent started, with its id + parsed arguments (for inline activity UIs). */
export interface ToolCallInfo {
  toolCallId?: string;
  toolName: string;
  args?: Record<string, unknown>;
}
/** A tool's result, correlated back to its call by `toolCallId`. */
export interface ToolResultInfo {
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

export interface StreamHandlers {
  onText: (delta: string) => void;
  /** Reasoning ("thinking") deltas — shown live while generating, never part of the final content. */
  onReasoning?: (delta: string) => void;
  /** A tool call began. `info` carries the tool id + args (filename, command, …) when the stream
   *  provides them; callers that only need the name can read `info.toolName`. */
  onToolStart?: (info: ToolCallInfo) => void;
  /** A tool call finished, carrying its result payload — correlate via `info.toolCallId`. */
  onToolResult?: (info: ToolResultInfo) => void;
  /** Processor abort (e.g. provider not configured) — code is the metadata.code, reason is the message. */
  onTripwire?: (code: string | undefined, reason: string) => void;
  /** The provider+model that produced this turn, e.g. "Gemini · gemini-2.0-flash". */
  onModel?: (label: string) => void;
  /** The turn's terminal `finish` chunk, with its finish reason when the stream provides one —
   *  'stop' is a natural end; 'tool-calls'/'length' mean the agent was cut off mid-work (step or
   *  token limit) and a caller may choose to auto-continue. */
  onFinish?: (reason: string | undefined) => void;
  onError?: (message: string) => void;
}

/** Best-effort finish reason across the payload shapes Mastra/AI-SDK streams have used. */
export function readFinishReason(payload: Record<string, unknown>): string | undefined {
  const step = payload.stepResult as { reason?: unknown } | undefined;
  const raw = payload.finishReason ?? step?.reason ?? payload.reason;
  return typeof raw === 'string' ? raw : undefined;
}

/** Pull the tool args out of a tool-call chunk payload across the field names Mastra has used. */
export function readToolArgs(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = payload.args ?? payload.input ?? payload.arguments;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A failed tool call arrives as a DISTINCT `tool-error` chunk, not a `tool-result` with `isError`
 * (confirmed against a live stream — its payload is `{ error: { cause: { message } }, ... }`,
 * unrelated in shape to a successful result). Pull out the clean underlying message.
 */
export function readToolErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error as Record<string, unknown> | undefined;
  const cause = error?.cause as Record<string, unknown> | undefined;
  const details = error?.details as Record<string, unknown> | undefined;
  const msg = cause?.message ?? details?.errorMessage ?? error?.message;
  return typeof msg === 'string' && msg ? msg : 'Tool call failed.';
}

/**
 * Turn a raw model id into a friendly "Provider · model" label. Handles Portkey inline ids
 * (`openai/@{slug}/{segment}`) and bare provider model names returned in the finish chunk.
 */
export function parseModelLabel(modelId: unknown): string | null {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  let segment = modelId.trim();
  let slug: string | null = null;
  // Strip a Portkey routing prefix: `openai/@{slug}/{segment}` → `{segment}` (keep the slug: it
  // encodes the provider for advanced/BYOK routes, e.g. `{tenant}-openrouter`).
  const m = /^[^/]+\/@([^/@]+)\/(.+)$/i.exec(segment) ?? /^@([^/@]+)\/(.+)$/i.exec(segment);
  if (m) {
    slug = m[1];
    segment = m[2];
  }
  return `${detectProvider(segment, slug)} · ${segment}`;
}

/** Best-effort friendly provider name from the Portkey slug suffix, then the model-name pattern. */
function detectProvider(segment: string, slug: string | null): string {
  const s = segment.toLowerCase();
  if (slug) {
    if (/-openrouter$/.test(slug)) return 'OpenRouter';
    if (/-anthropic$/.test(slug)) return 'Anthropic';
    if (/-openai$/.test(slug)) return 'OpenAI';
    if (/-gemini$/.test(slug)) return 'Gemini';
  }
  if (/(^|\/)gemini[-/]/.test(s) || s.startsWith('gemini')) return 'Gemini';
  if (s.includes('claude')) return 'Anthropic';
  if (s.startsWith('gpt') || s.startsWith('o1') || s.startsWith('o3') || s.startsWith('o4')) return 'OpenAI';
  return 'Groq';
}

/**
 * Stream one user turn from the general agent and dispatch chunks to handlers.
 * `shouldStop()` lets the UI abort applying further chunks (client-js 1.17.1 has no
 * abortSignal on stream(), so Stop simply ignores the rest of the stream).
 */
export async function streamChat(
  client: MastraClient,
  message: string,
  threadId: string,
  resource: string,
  handlers: StreamHandlers,
  shouldStop: () => boolean = () => false,
  /** Optional model the user pinned in the chat box (a `${provider}/${segment}` code). */
  pinnedModel?: string,
): Promise<void> {
  // Lightweight perf trace: time-to-first-token (first text) + total. Logged so we can compare before/
  // after the tool-preload change on web and native (check devtools / Android logcat).
  const t0 = (globalThis.performance?.now?.() ?? Date.now());
  let firstTextAt: number | null = null;
  try {
    const res = await client.getAgent(AGENT_ID).stream([{ role: 'user', content: message }], {
      // `resource` is required by the stream endpoint's body schema; the server still
      // overrides it with the tenant from the auth token in production.
      memory: { thread: threadId, resource },
      // channel:'web' → server processors skip Discord formatting (plain markdown back).
      // timezone/nowIso let the agent reason in the user's LOCAL time (e.g. "tomorrow 4am"); language
      // makes the agent reply in the user's chosen language (read from the same key the i18n engine uses).
      requestContext: {
        channel: 'web',
        timezone: browserTimezone(),
        nowIso: new Date().toISOString(),
        language: currentLang(),
        // `groqModel` pins one model for this run (validated server-side against the tenant's active
        // providers + allowed models). Omitted → the default free round-robin picks.
        ...(pinnedModel ? { groqModel: pinnedModel } : {}),
      } as never,
    });

    // chunk is @mastra/core's ChunkType union; read loosely to avoid importing the heavy type.
    await res.processDataStream({
      onChunk: async (chunk: any) => {
        if (shouldStop()) return;
        const payload = chunk?.payload ?? {};
        switch (chunk?.type) {
          case 'reasoning-delta': {
            // Separate "thinking" stream (most reasoning models) → live indicator only.
            const r = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : '';
            if (r) handlers.onReasoning?.(r);
            break;
          }
          case 'text-delta':
            if (typeof payload.text === 'string') {
              if (firstTextAt === null) {
                firstTextAt = (globalThis.performance?.now?.() ?? Date.now());
                console.info(`[chat] time-to-first-token: ${Math.round(firstTextAt - t0)}ms`);
              }
              handlers.onText(payload.text);
            }
            break;
          case 'tool-call':
            handlers.onToolStart?.({
              toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
              toolName: typeof payload.toolName === 'string' ? payload.toolName : 'tool',
              args: readToolArgs(payload),
            });
            break;
          case 'tool-result':
            handlers.onToolResult?.({
              toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
              toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
              result: payload.result ?? payload.output,
              isError: payload.isError === true,
            });
            break;
          case 'tool-error':
            handlers.onToolResult?.({
              toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
              toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
              result: readToolErrorMessage(payload),
              isError: true,
            });
            break;
          case 'tripwire':
            handlers.onTripwire?.(payload.metadata?.code, payload.reason ?? 'Request blocked.');
            break;
          case 'step-finish':
          case 'finish': {
            // The Portkey/provider model that produced this step (response.modelId).
            const id = payload.response?.modelId ?? payload.metadata?.modelId;
            const label = parseModelLabel(id);
            if (label) handlers.onModel?.(label);
            break;
          }
          case 'error':
            handlers.onError?.(friendlyStreamError(payload.error ?? payload));
            break;
        }
      },
    });
    console.info(`[chat] total stream time: ${Math.round((globalThis.performance?.now?.() ?? Date.now()) - t0)}ms`);
  } catch (err) {
    handlers.onError?.(friendlyStreamError(err));
  }
}

/**
 * Map a raw provider/Portkey error to a short, human message. Quota / rate-limit responses (Google
 * `RESOURCE_EXHAUSTED`, HTTP 429) get a friendly nudge instead of dumping the raw JSON blob — the
 * agent already rolls across models/providers, so this only shows when everything is exhausted.
 */
/** First retry-after hint (seconds) found in a provider error (Groq/Google/HTTP). */
function retryAfterSeconds(raw: string): number | null {
  for (const re of [
    /(?:try again|retry)(?: again)? in ([\d.]+)\s*s/i,
    /"?retryDelay"?\s*:\s*"?([\d.]+)s/i,
    /retry-after["':\s]+([\d.]+)/i,
  ]) {
    const n = parseFloat(re.exec(raw)?.[1] ?? '');
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return null;
}

export function friendlyStreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '');
  const retry = retryAfterSeconds(raw);
  const soon = retry ? ` Please try again in about ${retry} second${retry === 1 ? '' : 's'}.` : ' Please try again shortly.';

  // Request too large for the current model (per-request token / TPM ceiling).
  if (/request too large|reduce your message size|tokens per minute|exceeded.*input token/i.test(raw)) {
    return `That message was a bit too large for the current model — the agent will try a bigger one. Try a shorter message, or connect another provider (Groq/Gemini) for more headroom.`;
  }
  // Rate limit / quota exhausted across providers.
  if (/resource_exhausted|exceeded your current quota|\b429\b|too many requests|rate limit/i.test(raw)) {
    return `We're a bit over the request/token limit right now.${soon} Connecting both Groq and Gemini gives the agent more headroom.`;
  }
  return raw || 'Something went wrong. Please try again.';
}

const SUGGEST_FENCE = '```suggest';

/**
 * Split a completed (or in-progress) assistant message into clean markdown + optional chips.
 * The agent ends a web reply with a fenced ```suggest ["A","B"]``` block. We strip the LAST such
 * fence whether it's closed or not — so a partial fence mid-stream never renders as an empty
 * ```suggest code block, and an empty/malformed block yields no chips and a clean body.
 */
export function parseSuggestions(text: string): { body: string; suggestions: string[] } {
  const start = text.lastIndexOf(SUGGEST_FENCE);
  if (start === -1) return { body: text, suggestions: [] };

  const after = text.slice(start + SUGGEST_FENCE.length);
  const closeRel = after.indexOf('```');
  let suggestions: string[] = [];
  if (closeRel !== -1) {
    try {
      const parsed = JSON.parse(after.slice(0, closeRel).trim());
      if (Array.isArray(parsed)) {
        suggestions = parsed.map((s) => String(s)).filter(Boolean).slice(0, 4);
      }
    } catch {
      suggestions = [];
    }
  }
  // Cut the fence (closed or unclosed) off the rendered body.
  return { body: text.slice(0, start).trimEnd(), suggestions };
}
