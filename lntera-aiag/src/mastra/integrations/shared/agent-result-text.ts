import { REGEX_INPUT_BLOCKED_FRIENDLY_MESSAGE } from '../../agents/agent-regex-filter-config';
import { stripReasoning } from './strip-reasoning';

export type AgentGenerateResultLike = {
  text?: unknown;
  tripwire?: {
    reason?: unknown;
    processorId?: unknown;
    metadata?: unknown;
  };
};

function isRegexInputBlockedTripwire(tripwire: AgentGenerateResultLike['tripwire']): boolean {
  if (!tripwire || typeof tripwire !== 'object') return false;

  const processorId = tripwire.processorId;
  if (processorId === 'regex-filter' || processorId === 'regex-input-guard') {
    return true;
  }

  const metadata = tripwire.metadata;
  if (metadata && typeof metadata === 'object') {
    const code = (metadata as { code?: unknown }).code;
    if (code === 'regex_input_blocked') return true;
  }

  const reason = tripwire.reason;
  if (typeof reason === 'string' && reason.startsWith('Regex filter: blocked')) {
    return true;
  }

  return false;
}

/** Prefer tripwire reason (processor abort) over normal LLM text. */
export function resolveAgentTextFromResult(result: AgentGenerateResultLike): string {
  if (isRegexInputBlockedTripwire(result.tripwire)) {
    return REGEX_INPUT_BLOCKED_FRIENDLY_MESSAGE;
  }

  const tripwireReason = result.tripwire?.reason;
  if (typeof tripwireReason === 'string' && tripwireReason.trim().length > 0) {
    return tripwireReason.trim();
  }
  // Strip any inline reasoning (<think>…</think> etc.) so notifications/replies never show it.
  return typeof result.text === 'string' ? stripReasoning(result.text).trim() : '';
}
