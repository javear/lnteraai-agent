import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type {
  ProcessAPIErrorArgs,
  ProcessAPIErrorResult,
  ProcessInputStepArgs,
  Processor,
} from '@mastra/core/processors';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import {
  GROQ_FORCE_MODEL_KEY,
  GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY,
  getOrCreateGroqChainOrder,
  needsLargeContextGroqChain,
  pickNextGroqModelInChain,
  readGroqChainOrderFromRequestContext,
  SMALL_MODEL_TOOL_SCHEMA_OVERHEAD_TOKENS,
  syncGroqChainOrderToRequestContext,
} from '../models/groq-model-chain';
import {
  extractGroqRateLimitFromError,
  isGroqModelRateLimited,
  markGroqModelRateLimited,
} from './groq-rate-limit-cache';

/**
 * Groq model ids / substrings known to reject OpenAI-style `messages[].reasoning`
 * on chat completions (rolling fallback must not send prior reasoning turns verbatim).
 *
 * Extend this list when Groq adds models with the same restriction.
 */
export const GROQ_MODEL_SUBSTRINGS_WITHOUT_REASONING_SUPPORT = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  /** Groq router + API use `meta-llama/llama-4-scout-17b-16e-instruct`. */
  'llama-4-scout-17b-16e-instruct',
] as const;

const REASONING_UNSUPPORTED_API_HINT =
  /reasoning\b.*not supported|not supported\b.*reasoning|messages\[\d+\]\.reasoning/i;

const SMALL_GROQ_MODEL_SUBSTRINGS = ['llama-3.1-8b-instant'] as const;

const LAST_MODEL_IDENTITY_STATE_KEY = 'lastModelIdentity';

function resolveTenantId(requestContext: ProcessInputStepArgs['requestContext']): string | null {
  const raw = requestContext?.get?.(TENANT_MASTER_ID_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function resolvePinnedModel(requestContext: ProcessInputStepArgs['requestContext']): string | undefined {
  const raw = requestContext?.get?.('groqModel');
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function resolveActiveModelIdentity(model: unknown): string {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return '';
  const o = model as Record<string, unknown>;
  const provider =
    typeof o.provider === 'string'
      ? o.provider
      : typeof o.providerId === 'string'
        ? o.providerId
        : '';
  const modelId = typeof o.modelId === 'string' ? o.modelId : '';
  if (provider && modelId) return `${provider}/${modelId}`;
  return modelId;
}

function groqModelRejectsSerializedReasoning(modelIdentity: string): boolean {
  const id = modelIdentity.toLowerCase();
  return GROQ_MODEL_SUBSTRINGS_WITHOUT_REASONING_SUPPORT.some((s) => id.includes(s.toLowerCase()));
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

function stripReasoningFromMessages(messages: MastraDBMessage[]): void {
  for (const msg of messages) {
    const content = msg.content;
    if (!content || typeof content !== 'object') continue;

    if (Array.isArray(content.parts)) {
      content.parts = content.parts.filter((part) => {
        const t = (part as { type?: string }).type;
        return t !== 'reasoning';
      });
    }

    if ('reasoning' in content && content.reasoning !== undefined) {
      delete content.reasoning;
    }
  }
}

function resolveChainOrderForStep(args: ProcessInputStepArgs): string[] {
  const toolCount = args.tools ? Object.keys(args.tools).length : 0;
  const largeContext = needsLargeContextGroqChain(approximateConversationTokens(args), toolCount);
  const order = getOrCreateGroqChainOrder(args.state, {
    largeContext,
    pinned: resolvePinnedModel(args.requestContext),
  });
  syncGroqChainOrderToRequestContext(args.requestContext, order, largeContext);
  return order;
}

/**
 * Lets the general agent rotate across Groq models: reasoning-capable models still receive
 * full history (including reasoning parts); models that reject `reasoning` get history
 * sanitized for that step only.
 *
 * Also tracks per-tenant Groq TPM rate limits (429): skips models until
 * `x-ratelimit-reset-tokens` expires so the rolling fallback chain does not retry hot models.
 */
export const groqReasoningRollingCompatProcessor = {
  id: 'groq-reasoning-rolling-compat',
  name: 'Groq reasoning compat (rolling models)',

  processInputStep(args: ProcessInputStepArgs): { model?: string } | void {
    const forced = args.requestContext?.get?.(GROQ_FORCE_MODEL_KEY);
    if (typeof forced === 'string' && forced.length > 0) {
      args.state[LAST_MODEL_IDENTITY_STATE_KEY] = forced;
      delete args.state[GROQ_FORCE_MODEL_KEY];
      args.requestContext?.set?.(GROQ_FORCE_MODEL_KEY, undefined);
      return { model: forced };
    }

    const identity = resolveActiveModelIdentity(args.model);
    args.state[LAST_MODEL_IDENTITY_STATE_KEY] = identity;

    const chainOrder = resolveChainOrderForStep(args);
    const tenantId = resolveTenantId(args.requestContext);

    if (isGroqModelRateLimited(tenantId, identity)) {
      const next = pickNextGroqModelInChain({
        tenantId,
        chainOrder,
        afterIdentity: identity,
      });
      if (next) return { model: next };
    }

    if (groqModelRejectsSerializedReasoning(identity)) {
      stripReasoningFromMessages(args.messageList.get.all.db());
    }

    if (!isSmallGroqModel(identity)) return;

    const toolCount = args.tools ? Object.keys(args.tools).length : 0;
    if (!needsLargeContextGroqChain(approximateConversationTokens(args), toolCount)) return;

    const largePreferred = chainOrder.find((m) => !isSmallGroqModel(m));
    if (largePreferred && largePreferred !== identity) {
      return { model: largePreferred };
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

      const largeContext = state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY] === true;
      const chainOrder =
        readGroqChainOrderFromRequestContext(requestContext) ??
        getOrCreateGroqChainOrder(state, {
          largeContext,
          pinned: resolvePinnedModel(requestContext),
        });

      if (chainOrder.length > 0) {
        const next = pickNextGroqModelInChain({
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

    if (!REASONING_UNSUPPORTED_API_HINT.test(text)) return;

    stripReasoningFromMessages(messageList.get.all.db());
    return { retry: true };
  },
} satisfies Processor<'groq-reasoning-rolling-compat'>;
