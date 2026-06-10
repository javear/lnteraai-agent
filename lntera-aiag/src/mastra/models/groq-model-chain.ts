import {
  GROQ_TOOL_MODELS,
  isGroqToolModelId,
  type GroqToolModelId,
} from './groq-tool-models';
import {
  extractGroqRateLimitFromError,
  isGroqModelRateLimited,
  normalizeGroqModelCode,
} from '../processors/groq-rate-limit-cache';

export const GROQ_MODEL_CHAIN_ORDER_KEY = 'groqModelChainOrder';
export const GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY = 'groqModelChainLargeContext';
/** Set by processAPIError after 429 so the next step uses this model explicitly. */
export const GROQ_FORCE_MODEL_KEY = 'groqForceModel';

export const GROQ_CHAIN_STATE_KEY = GROQ_MODEL_CHAIN_ORDER_KEY;

export type GroqModelChainEntry = { model: string; maxRetries: number };

const SMALL_GROQ_SUBSTRINGS = ['llama-3.1-8b-instant'] as const;

/** Prefer these first when the turn is large (tools + history). */
const LARGE_CONTEXT_PREFERRED: readonly GroqToolModelId[] = [
  'groq/openai/gpt-oss-120b',
  'groq/qwen/qwen3-32b',
  'groq/llama-3.3-70b-versatile',
  'groq/openai/gpt-oss-20b',
  'groq/meta-llama/llama-4-scout-17b-16e-instruct',
];

export const SMALL_MODEL_MAX_ESTIMATED_TOKENS = 3_200;
export const SMALL_MODEL_TOOL_SCHEMA_OVERHEAD_TOKENS = 1_800;

export function needsLargeContextGroqChain(estimatedTokens: number, toolCount: number): boolean {
  if (estimatedTokens > SMALL_MODEL_MAX_ESTIMATED_TOKENS) return true;
  if (toolCount >= 2 && estimatedTokens > 1_200) return true;
  return false;
}

function isSmallGroqModelId(model: string): boolean {
  const id = model.toLowerCase();
  return SMALL_GROQ_SUBSTRINGS.some((s) => id.includes(s));
}

/** Pool for chain rotation: large-context turns omit 8b from the head of the pool. */
export function partitionGroqModelsForContext(largeContext: boolean): readonly string[] {
  if (!largeContext) return GROQ_TOOL_MODELS;

  const preferredSet = new Set(LARGE_CONTEXT_PREFERRED);
  const preferred = LARGE_CONTEXT_PREFERRED.filter((m) => (GROQ_TOOL_MODELS as readonly string[]).includes(m));
  const tail = GROQ_TOOL_MODELS.filter((m) => !preferredSet.has(m) && !isSmallGroqModelId(m));
  return [...preferred, ...tail];
}

export function rotateGroqModelList(models: readonly string[], seed?: number): string[] {
  if (models.length === 0) return [];
  const start =
    seed != null && Number.isFinite(seed)
      ? Math.abs(Math.floor(seed)) % models.length
      : Math.floor(Math.random() * models.length);
  return [...models.slice(start), ...models.slice(0, start)];
}

export function buildGroqModelChainEntries(models: readonly string[]): GroqModelChainEntry[] {
  return models.map((model) => ({ model, maxRetries: 1 }));
}

export function resolvePinnedGroqChain(pinned?: string): GroqModelChainEntry[] | null {
  if (pinned && isGroqToolModelId(pinned)) {
    return [{ model: pinned, maxRetries: 1 }];
  }
  return null;
}

export function filterGroqChainByRateLimit(
  tenantId: string | null | undefined,
  chain: GroqModelChainEntry[],
): { available: GroqModelChainEntry[]; allCoolingDown: boolean } {
  const available = chain.filter(({ model }) => !isGroqModelRateLimited(tenantId, model));
  return {
    available: available.length > 0 ? available : chain,
    allCoolingDown: available.length === 0 && chain.length > 0,
  };
}

/**
 * Next model in pinned run order after `afterIdentity`, skipping rate-limited entries.
 * Walks the rotated list once (wrap not needed for Mastra chain advance).
 */
export function pickNextGroqModelInChain(args: {
  tenantId: string | null | undefined;
  chainOrder: readonly string[];
  afterIdentity: string;
}): string | null {
  const afterNorm = normalizeGroqModelCode(args.afterIdentity);
  if (!afterNorm) return null;

  const idx = args.chainOrder.findIndex((m) => normalizeGroqModelCode(m) === afterNorm);
  const start = idx >= 0 ? idx + 1 : 0;

  for (let i = start; i < args.chainOrder.length; i++) {
    const model = args.chainOrder[i];
    if (!isGroqModelRateLimited(args.tenantId, model)) return model;
  }
  for (let i = 0; i < start && i < args.chainOrder.length; i++) {
    const model = args.chainOrder[i];
    if (!isGroqModelRateLimited(args.tenantId, model)) return model;
  }
  return null;
}

/** Pin one rotated chain order per agent run (processor state). */
export function getOrCreateGroqChainOrder(
  state: Record<string, unknown>,
  args: { largeContext: boolean; pinned?: string },
): string[] {
  const existing = state[GROQ_CHAIN_STATE_KEY];
  const existingLarge = state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY];
  if (
    Array.isArray(existing) &&
    existing.every((x) => typeof x === 'string') &&
    existingLarge === args.largeContext
  ) {
    return existing as string[];
  }

  const pinnedChain = resolvePinnedGroqChain(args.pinned);
  if (pinnedChain) {
    const order = pinnedChain.map((e) => e.model);
    state[GROQ_CHAIN_STATE_KEY] = order;
    state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY] = args.largeContext;
    return order;
  }

  const pool = partitionGroqModelsForContext(args.largeContext);
  const order = rotateGroqModelList(pool);
  state[GROQ_CHAIN_STATE_KEY] = order;
  state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY] = args.largeContext;
  return order;
}

export function readGroqChainOrderFromRequestContext(
  requestContext: { get?: (key: string) => unknown } | undefined,
): string[] | null {
  const raw = requestContext?.get?.(GROQ_MODEL_CHAIN_ORDER_KEY);
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) return null;
  return raw as string[];
}

export function syncGroqChainOrderToRequestContext(
  requestContext: { set?: (key: string, value: unknown) => void } | undefined,
  order: string[],
  largeContext: boolean,
): void {
  requestContext?.set?.(GROQ_MODEL_CHAIN_ORDER_KEY, order);
  requestContext?.set?.(GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY, largeContext);
}

export function buildAvailableGroqChain(args: {
  tenantId: string | null | undefined;
  pinned?: string;
  largeContext?: boolean;
  chainOrder?: readonly string[];
}): GroqModelChainEntry[] {
  const pinnedChain = resolvePinnedGroqChain(args.pinned);
  if (pinnedChain) {
    return filterGroqChainByRateLimit(args.tenantId, pinnedChain).available;
  }

  const pool = partitionGroqModelsForContext(args.largeContext ?? false);
  const order = args.chainOrder ?? rotateGroqModelList(pool);
  const entries = buildGroqModelChainEntries(order);
  return filterGroqChainByRateLimit(args.tenantId, entries).available;
}

/** True when every tool model in the pool is in cooldown for this tenant. */
export function allGroqToolModelsRateLimited(tenantId: string | null | undefined): boolean {
  return GROQ_TOOL_MODELS.every((m) => isGroqModelRateLimited(tenantId, m));
}

export function groqAllModelsCoolingMessage(): string {
  return (
    'All Groq models are temporarily rate-limited. Please wait about a minute and try again, ' +
    'or upgrade your Groq tier for higher TPM.'
  );
}

export function isGroqRateLimitError(error: unknown): boolean {
  return extractGroqRateLimitFromError(error) != null;
}
