import { extractGroqRateLimitFromError } from '../../processors/groq-rate-limit-cache';

/**
 * A user-facing apology for a rate-limit / quota / oversize failure, with a retry-after hint when
 * known. Provider-agnostic (the extractor parses Groq AND Google/Gemini errors). Returns `null` when
 * the error isn't a limit — callers fall back to a generic "something went wrong" message.
 */
export function friendlyAgentLimitMessage(error: unknown): string | null {
  const rl = extractGroqRateLimitFromError(error);
  if (!rl) return null;

  const secs = Math.max(1, Math.ceil(rl.ttlMs / 1000));
  const when = `Please try again in about ${secs} second${secs === 1 ? '' : 's'}.`;

  if (rl.limitTokens) {
    // "Request too large" — the message exceeded a model's per-request token ceiling.
    return (
      `That request was a bit too large for the available model right now. Try a shorter message, ` +
      `or connect another LLM provider (Groq/Gemini) for more headroom. ${when}`
    );
  }
  return (
    `We're over the request/token limit right now. ${when} ` +
    `Connecting both Groq and Gemini gives the agent more headroom.`
  );
}
