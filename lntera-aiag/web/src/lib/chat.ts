import type { MastraClient } from '@mastra/client-js';
import { AGENT_ID } from './mastra';

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
  try {
    const res = await client.getAgent(AGENT_ID).stream([{ role: 'user', content: message }], {
      // `resource` is required by the stream endpoint's body schema; the server still
      // overrides it with the tenant from the auth token in production.
      memory: { thread: threadId, resource },
      // channel:'web' → server processors skip Discord formatting (plain markdown back).
      requestContext: { channel: 'web' } as never,
    });

    // chunk is @mastra/core's ChunkType union; read loosely to avoid importing the heavy type.
    await res.processDataStream({
      onChunk: async (chunk: any) => {
        if (shouldStop()) return;
        const payload = chunk?.payload ?? {};
        switch (chunk?.type) {
          case 'text-delta':
            if (typeof payload.text === 'string') handlers.onText(payload.text);
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
  } catch (err) {
    handlers.onError?.(friendlyStreamError(err));
  }
}

/**
 * Map a raw provider/Portkey error to a short, human message. Quota / rate-limit responses (Google
 * `RESOURCE_EXHAUSTED`, HTTP 429) get a friendly nudge instead of dumping the raw JSON blob — the
 * agent already rolls across models/providers, so this only shows when everything is exhausted.
 */
export function friendlyStreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? '');
  if (/resource_exhausted|exceeded your current quota|\b429\b|too many requests|rate limit/i.test(raw)) {
    return "This model's free quota is used up right now. The agent retries other models automatically — for more headroom, connect Groq as well or enable billing on your Gemini key.";
  }
  return raw || 'Something went wrong. Please try again.';
}

const SUGGEST_RE = /```suggest\s*([\s\S]*?)```\s*$/;

/**
 * Split a completed assistant message into clean markdown + optional suggestion chips.
 * The agent may end a web reply with a fenced ```suggest ["A","B"]``` block.
 */
export function parseSuggestions(text: string): { body: string; suggestions: string[] } {
  const m = text.match(SUGGEST_RE);
  if (!m) return { body: text, suggestions: [] };
  let suggestions: string[] = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed)) {
      suggestions = parsed.map((s) => String(s)).filter(Boolean).slice(0, 4);
    }
  } catch {
    suggestions = [];
  }
  return { body: text.slice(0, m.index).trimEnd(), suggestions };
}
