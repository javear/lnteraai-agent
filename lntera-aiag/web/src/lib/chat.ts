import type { MastraClient } from '@mastra/client-js';
import { AGENT_ID } from './mastra';
import { browserTimezone } from './insights';

export interface StreamHandlers {
  onText: (delta: string) => void;
  onToolStart?: (toolName: string) => void;
  /** Processor abort (e.g. provider not configured) — code is the metadata.code, reason is the message. */
  onTripwire?: (code: string | undefined, reason: string) => void;
  /** The provider+model that produced this turn, e.g. "Gemini · gemini-2.0-flash". */
  onModel?: (label: string) => void;
  onError?: (message: string) => void;
}

/**
 * Turn a raw model id into a friendly "Provider · model" label. Handles Portkey inline ids
 * (`openai/@{slug}/{segment}`) and bare provider model names returned in the finish chunk.
 */
export function parseModelLabel(modelId: unknown): string | null {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  let segment = modelId.trim();
  // Strip a Portkey routing prefix: `openai/@{slug}/{segment}` → `{segment}`.
  const m = /^[^/]+\/@[^/@]+\/(.+)$/i.exec(segment) ?? /^@[^/@]+\/(.+)$/i.exec(segment);
  if (m?.[1]) segment = m[1];
  const provider = /(^|\/)gemini[-/]/i.test(segment) || segment.toLowerCase().startsWith('gemini')
    ? 'Gemini'
    : 'Groq';
  return `${provider} · ${segment}`;
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
      // timezone/nowIso let the agent reason in the user's LOCAL time (e.g. "tomorrow 4am") and the
      // schedule-future-task tool resolve fire times in the right zone.
      requestContext: { channel: 'web', timezone: browserTimezone(), nowIso: new Date().toISOString() } as never,
    });

    // chunk is @mastra/core's ChunkType union; read loosely to avoid importing the heavy type.
    await res.processDataStream({
      onChunk: async (chunk: any) => {
        if (shouldStop()) return;
        const payload = chunk?.payload ?? {};
        switch (chunk?.type) {
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
            handlers.onToolStart?.(typeof payload.toolName === 'string' ? payload.toolName : 'tool');
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
