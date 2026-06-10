import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type {
  ProcessAPIErrorArgs,
  ProcessAPIErrorResult,
  ProcessInputStepArgs,
  ProcessInputStepResult,
  Processor,
} from '@mastra/core/processors';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import {
  extractGroqModelIdentity,
  PORTKEY_PROVIDER_SLUGS_KEY,
  resolveModelOverrideForRequestContext,
} from '../integrations/portkey/model-config';
import {
  GROQ_FORCE_MODEL_KEY,
  GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY,
  getOrCreateLlmChainOrder,
  needsLargeContextGroqChain,
  pickFittingModel,
  pickNextGroqModelInChain,
  readGroqChainOrderFromRequestContext,
  SMALL_MODEL_TOOL_SCHEMA_OVERHEAD_TOKENS,
  syncGroqChainOrderToRequestContext,
} from '../models/llm-model-chain';
import { isLlmProviderCode, type LlmProviderCode } from '../models/llm-providers';
import {
  extractGroqRateLimitFromError,
  getModelTokenCeiling,
  isGroqModelRateLimited,
  markGroqModelRateLimited,
  markModelTokenCeiling,
  normalizeGroqModelCode,
} from './groq-rate-limit-cache';

/**
 * Groq models known to reject replayed `messages[].reasoning` / `reasoning_content`.
 * History is stripped proactively for every model in the rolling chain (see processInputStep).
 */
export const GROQ_MODEL_SUBSTRINGS_WITHOUT_REASONING_SUPPORT = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'llama-4-scout-17b-16e-instruct',
  'gpt-oss-20b',
  'gpt-oss-120b',
] as const;

const REASONING_UNSUPPORTED_API_HINT =
  /reasoning(?:_content)?\s*(?:is\s+)?unsupported|unsupported.*reasoning(?:_content)?|reasoning\b.*not supported|not supported\b.*reasoning|messages[.\[]\d+.*reasoning(?:_content)?/i;

const REASONING_MESSAGE_FIELDS = ['reasoning', 'reasoning_content'] as const;

export function isGroqReasoningUnsupportedError(text: string): boolean {
  return REASONING_UNSUPPORTED_API_HINT.test(text);
}

function deleteReasoningFields(record: Record<string, unknown>): void {
  for (const key of REASONING_MESSAGE_FIELDS) {
    if (key in record) delete record[key];
  }
}

/** Strip reasoning fields from replayed history before Groq chat completions. */
export function stripReasoningFromMessages(messages: MastraDBMessage[]): void {
  for (const msg of messages) {
    if (msg && typeof msg === 'object') {
      deleteReasoningFields(msg as Record<string, unknown>);
    }

    const content = msg.content;
    if (!content || typeof content !== 'object') continue;

    deleteReasoningFields(content as Record<string, unknown>);

    if (Array.isArray(content.parts)) {
      content.parts = content.parts.filter((part) => {
        if (!part || typeof part !== 'object') return true;
        const p = part as Record<string, unknown>;
        if (p.type === 'reasoning') return false;
        deleteReasoningFields(p);
        return true;
      });
    }
  }
}

const LAST_MODEL_IDENTITY_STATE_KEY = 'lastModelIdentity';

function resolveTenantId(requestContext: ProcessInputStepArgs['requestContext']): string | null {
  const raw = requestContext?.get?.(TENANT_MASTER_ID_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function resolvePinnedModel(requestContext: ProcessInputStepArgs['requestContext']): string | undefined {
  const raw = requestContext?.get?.('groqModel');
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** The tenant's active provider codes, from the slug map set by the agent (defaults to groq). */
function resolveProviderCodes(
  requestContext: ProcessInputStepArgs['requestContext'],
): LlmProviderCode[] {
  const raw = requestContext?.get?.(PORTKEY_PROVIDER_SLUGS_KEY);
  if (raw && typeof raw === 'object') {
    const codes = Object.keys(raw as Record<string, unknown>).filter(isLlmProviderCode);
    if (codes.length > 0) return codes;
  }
  return ['groq'];
}

function resolveActiveModelIdentity(model: unknown): string {
  return extractGroqModelIdentity(model);
}

function stripReasoningFromInputStep(args: ProcessInputStepArgs): void {
  stripReasoningFromMessages(args.messageList.get.all.db());
  stripReasoningFromMessages(args.messages as MastraDBMessage[]);
}

function isSmallGroqModel(modelIdentity: string): boolean {
  const id = modelIdentity.toLowerCase();
  return SMALL_GROQ_MODEL_SUBSTRINGS.some((s) => id.includes(s.toLowerCase()));
}

function approximateTokensFromUnknown(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  return Math.ceil(JSON.stringify(value).length / 4);
}

function approximateConversationTokens(args: ProcessInputStepArgs): number {
  let total = 0;

  for (const msg of args.messageList.get.all.db()) {
    total += approximateTokensFromUnknown(msg.content);
  }

  for (const message of args.messages) {
    total += approximateTokensFromUnknown(message.content);
  }

  for (const message of args.systemMessages) {
    total += approximateTokensFromUnknown(message.content);
  }

  if (args.steps?.length) {
    for (const step of args.steps) {
      total += approximateTokensFromUnknown(step);
    }
  }

  const toolCount = args.tools ? Object.keys(args.tools).length : 0;
  if (toolCount > 0) {
    total += approximateTokensFromUnknown(args.tools);
    total += SMALL_MODEL_TOOL_SCHEMA_OVERHEAD_TOKENS;
  }

  return total;
}

const SMALL_GROQ_MODEL_SUBSTRINGS = ['llama-3.1-8b-instant'] as const;

function resolveChainOrderForStep(
  args: ProcessInputStepArgs,
  estimate: number,
  tenantId: string | null,
): string[] {
  const toolCount = args.tools ? Object.keys(args.tools).length : 0;
  const largeContext = needsLargeContextGroqChain(estimate, toolCount);
  const order = getOrCreateLlmChainOrder(args.state, {
    largeContext,
    pinned: resolvePinnedModel(args.requestContext),
    providerCodes: resolveProviderCodes(args.requestContext),
    tenantId,
    estimatedTokens: estimate,
  });
  syncGroqChainOrderToRequestContext(args.requestContext, order, largeContext);
  return order;
}

/**
 * Lets the general agent rotate across Groq models. Replayed history never includes
 * `reasoning` / `reasoning_content` (stripped before every step) so any model in the
 * chain can consume memory without 400s. Current-turn reasoning in the live response
 * is unaffected; only prior turns are sanitized on send.
 *
 * Also tracks per-tenant Groq TPM rate limits (429): skips models until
 * `x-ratelimit-reset-tokens` expires so the rolling fallback chain does not retry hot models.
 */
export const groqReasoningRollingCompatProcessor = {
  id: 'groq-reasoning-rolling-compat',
  name: 'Groq reasoning compat (rolling models)',

  processInputStep(args: ProcessInputStepArgs): ProcessInputStepResult | void {
    stripReasoningFromInputStep(args);

    const forced = args.requestContext?.get?.(GROQ_FORCE_MODEL_KEY);
    if (typeof forced === 'string' && forced.length > 0) {
      args.state[LAST_MODEL_IDENTITY_STATE_KEY] = forced;
      delete args.state[GROQ_FORCE_MODEL_KEY];
      args.requestContext?.set?.(GROQ_FORCE_MODEL_KEY, undefined);
      return { model: resolveModelOverrideForRequestContext(forced, args.requestContext) };
    }

    const identity = resolveActiveModelIdentity(args.model);
    args.state[LAST_MODEL_IDENTITY_STATE_KEY] = identity;

    const tenantId = resolveTenantId(args.requestContext);
    const estimate = approximateConversationTokens(args);
    const chainOrder = resolveChainOrderForStep(args, estimate, tenantId);

    // 1) Current model is cooling down → roll to the next available model.
    if (isGroqModelRateLimited(tenantId, identity)) {
      const next = pickNextGroqModelInChain({ tenantId, chainOrder, afterIdentity: identity });
      if (next) {
        return { model: resolveModelOverrideForRequestContext(next, args.requestContext) };
      }
    }

    // 2) Size-aware: this request's estimated tokens exceed the current model's learned ceiling
    //    (TPM "request too large"). Proactively route to a model that can take it — the size-sorted
    //    chain puts the highest-capacity model (or Gemini) first, so this avoids the oversize error
    //    instead of discovering it. Falls back to the largest available model when none fully fits.
    const currentCeiling = getModelTokenCeiling(tenantId, identity);
    if (currentCeiling != null && estimate > currentCeiling) {
      const target =
        pickFittingModel(chainOrder, tenantId, estimate) ??
        chainOrder.find((m) => !isGroqModelRateLimited(tenantId, m));
      if (target && normalizeGroqModelCode(target) !== normalizeGroqModelCode(identity)) {
        return { model: resolveModelOverrideForRequestContext(target, args.requestContext) };
      }
    }

    // 3) Small model on a large-context turn → bump to a larger model.
    if (!isSmallGroqModel(identity)) return;
    const toolCount = args.tools ? Object.keys(args.tools).length : 0;
    if (!needsLargeContextGroqChain(estimate, toolCount)) return;

    const largePreferred = chainOrder.find((m) => !isSmallGroqModel(m));
    if (largePreferred && largePreferred !== identity) {
      return { model: resolveModelOverrideForRequestContext(largePreferred, args.requestContext) };
    }
  },

  processAPIError(args: ProcessAPIErrorArgs): ProcessAPIErrorResult | void {
    const { error, messageList, retryCount, requestContext, state } = args;

    const lastIdentity =
      typeof state[LAST_MODEL_IDENTITY_STATE_KEY] === 'string'
        ? state[LAST_MODEL_IDENTITY_STATE_KEY]
        : '';
    const rateLimit = extractGroqRateLimitFromError(error, lastIdentity);
    if (rateLimit) {
      const tenantId = resolveTenantId(requestContext);
      markGroqModelRateLimited(tenantId, rateLimit.modelCode, rateLimit.ttlMs);
      // "Request too large" tells us this model's real per-request token ceiling — learn it so the
      // next pick (and future requests) route to a model that can actually take this size.
      if (rateLimit.limitTokens) {
        markModelTokenCeiling(tenantId, rateLimit.modelCode, rateLimit.limitTokens);
      }

      const largeContext = state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY] === true;
      const chainOrder =
        readGroqChainOrderFromRequestContext(requestContext) ??
        getOrCreateLlmChainOrder(state, {
          largeContext,
          pinned: resolvePinnedModel(requestContext),
          providerCodes: resolveProviderCodes(requestContext),
          tenantId,
          estimatedTokens: rateLimit.requestedTokens,
        });

      if (chainOrder.length > 0) {
        // Prefer a model that fits the attempted size; else just move off the failed model.
        const next =
          (rateLimit.requestedTokens
            ? pickFittingModel(chainOrder, tenantId, rateLimit.requestedTokens)
            : null) ??
          pickNextGroqModelInChain({
            tenantId,
            chainOrder,
            afterIdentity: lastIdentity || rateLimit.modelCode,
          });
        if (next) {
          state[GROQ_FORCE_MODEL_KEY] = next;
          requestContext?.set?.(GROQ_FORCE_MODEL_KEY, next);
        }
      }
      return;
    }

    if (retryCount > 0) return;

    const text =
      error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);

    if (!isGroqReasoningUnsupportedError(text)) return;

    stripReasoningFromMessages(messageList.get.all.db());
    return { retry: true };
  },
} satisfies Processor<'groq-reasoning-rolling-compat'>;
