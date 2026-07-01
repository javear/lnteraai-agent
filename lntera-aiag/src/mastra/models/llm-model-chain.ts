import {
  getLlmProvider,
  type LlmProviderCode,
  providerCodeForModel,
  splitModelCode,
  toModelCode,
} from './llm-providers';
import {
  GROQ_CHAIN_STATE_KEY,
  GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY,
  rotateGroqModelList,
} from './groq-model-chain';
import { getModelTokenCeiling, isGroqModelRateLimited } from '../processors/groq-rate-limit-cache';

// Re-export the provider-agnostic chain plumbing so callers have a single import surface.
export {
  GROQ_FORCE_MODEL_KEY,
  GROQ_MODEL_CHAIN_ORDER_KEY,
  GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY,
  GROQ_CHAIN_STATE_KEY,
  SMALL_MODEL_TOOL_SCHEMA_OVERHEAD_TOKENS,
  needsLargeContextGroqChain,
  pickNextGroqModelInChain,
  readGroqChainOrderFromRequestContext,
  syncGroqChainOrderToRequestContext,
} from './groq-model-chain';

export type LlmModelChainEntry = { model: string; maxRetries: number };

export interface ActiveLlmProvider {
  code: LlmProviderCode;
  providerSlug: string;
  /** Advanced/BYOK providers only: the tenant's user-selected model segments. */
  selectedModels?: readonly string[];
}

/**
 * The model segments a provider may use in the chain: free providers use their curated
 * `toolModels`; advanced/BYOK providers use the tenant's `selectedModels` (they ship none).
 */
export function providerAllowedSegments(p: ActiveLlmProvider): readonly string[] {
  const def = getLlmProvider(p.code);
  if (!def) return [];
  return def.tier === 'advanced' ? (p.selectedModels ?? []) : def.toolModels;
}

/** One provider's context-aware, qualified modelCode pool (large turns deprioritize small models). */
export function buildProviderPool(p: ActiveLlmProvider, largeContext: boolean): string[] {
  const def = getLlmProvider(p.code);
  if (!def) return [];
  const segments = providerAllowedSegments(p);
  if (!largeContext) return segments.map((s) => toModelCode(p.code, s));

  const preferredSet = new Set(def.largeContextPreferred);
  const smallSet = new Set(def.smallModels);
  const preferred = def.largeContextPreferred.filter((s) => segments.includes(s));
  const tail = segments.filter((s) => !preferredSet.has(s) && !smallSet.has(s));
  return [...preferred, ...tail].map((s) => toModelCode(p.code, s));
}

/**
 * Combined default (unpinned) pool across the tenant's active providers. Only **free** providers
 * auto-rotate — advanced/BYOK (paid) providers are pin-only, so the round-robin never spends a
 * paid key on its own. If NO free provider is connected, advanced providers are used as the pool
 * so chat still works. Each provider's pool is independently rotated (random start), then providers
 * are interleaved round-robin in a randomized order (head ≈ picked at random, rest as fallbacks).
 */
export function buildCombinedLlmPool(providers: ActiveLlmProvider[], largeContext: boolean): string[] {
  const active = providers.filter((p) => getLlmProvider(p.code));
  if (active.length === 0) return [];
  const free = active.filter((p) => getLlmProvider(p.code)!.tier === 'free');
  const poolProviders = free.length > 0 ? free : active;
  if (poolProviders.length === 1) return rotateGroqModelList(buildProviderPool(poolProviders[0], largeContext));

  // Randomize provider interleave order (rotate the codes, which are unique), then map back.
  const byCode = new Map(poolProviders.map((p) => [p.code, p]));
  const order = rotateGroqModelList(poolProviders.map((p) => p.code));
  const pools = order.map((code) => rotateGroqModelList(buildProviderPool(byCode.get(code as LlmProviderCode)!, largeContext)));

  const result: string[] = [];
  const maxLen = Math.max(...pools.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const pool of pools) {
      if (i < pool.length) result.push(pool[i]);
    }
  }
  return result;
}

/**
 * If the user pinned a model and it belongs to an active provider AND is in that provider's allowed
 * set (free → toolModels, advanced → tenant selectedModels), run only that model. Otherwise null
 * (fall back to the default pool), so an unauthorized/unknown pin can't route a paid provider.
 */
export function resolvePinnedLlmChain(
  pinned: string | undefined,
  providers: ActiveLlmProvider[],
): string[] | null {
  if (!pinned) return null;
  const code = providerCodeForModel(pinned);
  if (!code) return null;
  const provider = providers.find((p) => p.code === code);
  if (!provider) return null;
  const segment = splitModelCode(pinned)?.segment ?? pinned.trim();
  if (!providerAllowedSegments(provider).includes(segment)) return null;
  return [toModelCode(code, segment)];
}

/**
 * Reorder a chain so models that can fit `estimatedTokens` come first (highest ceiling first), and
 * models whose known ceiling is below the estimate sink to the end (kept only as last resort). This
 * ONLY kicks in when some model in the chain can't fit (real size pressure) — otherwise the original
 * rotation is preserved so small requests still spread across models / providers.
 */
export function reorderBySizeCeiling(
  order: readonly string[],
  tenantId: string | null | undefined,
  estimatedTokens: number | undefined,
): string[] {
  if (!estimatedTokens || estimatedTokens <= 0 || order.length <= 1) return [...order];
  const ranked = order.map((code, i) => {
    const ceil = getModelTokenCeiling(tenantId, code);
    return {
      code,
      i,
      fits: ceil == null || ceil >= estimatedTokens,
      // Unknown ceiling ≈ "just fits" so it ranks below a known-larger model but above known-too-small.
      eff: ceil == null ? estimatedTokens : ceil,
    };
  });
  if (ranked.every((r) => r.fits)) return [...order]; // no size pressure → keep rotation
  ranked.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (b.eff !== a.eff) return b.eff - a.eff;
    return a.i - b.i;
  });
  return ranked.map((r) => r.code);
}

/** First chain model that can fit `estimatedTokens` and isn't cooling down; null if none fits. */
export function pickFittingModel(
  order: readonly string[],
  tenantId: string | null | undefined,
  estimatedTokens: number,
): string | null {
  for (const code of order) {
    if (isGroqModelRateLimited(tenantId, code)) continue;
    const ceil = getModelTokenCeiling(tenantId, code);
    if (ceil == null || ceil >= estimatedTokens) return code;
  }
  return null;
}

/** Pin one combined chain order per agent run (processor state), context-partitioned + size-aware. */
export function getOrCreateLlmChainOrder(
  state: Record<string, unknown>,
  args: {
    largeContext: boolean;
    pinned?: string;
    providers: ActiveLlmProvider[];
    tenantId?: string | null;
    estimatedTokens?: number;
  },
): string[] {
  const existing = state[GROQ_CHAIN_STATE_KEY];
  const existingLarge = state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY];
  if (
    Array.isArray(existing) &&
    existing.every((x) => typeof x === 'string') &&
    existingLarge === args.largeContext
  ) {
    // Re-apply size ordering each step (ceilings can be learned mid-run); base order stays in state.
    return reorderBySizeCeiling(existing as string[], args.tenantId, args.estimatedTokens);
  }

  const pinned = resolvePinnedLlmChain(args.pinned, args.providers);
  const order = pinned ?? buildCombinedLlmPool(args.providers, args.largeContext);
  state[GROQ_CHAIN_STATE_KEY] = order;
  state[GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY] = args.largeContext;
  return reorderBySizeCeiling(order, args.tenantId, args.estimatedTokens);
}

/**
 * Ordered chain of available (not rate-limited) models across all active providers, each tagged
 * with its Portkey provider slug so the caller can build per-model Portkey configs.
 */
export function buildAvailableLlmChain(args: {
  providers: ActiveLlmProvider[];
  tenantId: string | null | undefined;
  pinned?: string;
  largeContext?: boolean;
  chainOrder?: readonly string[];
}): { model: string; providerSlug: string; maxRetries: number }[] {
  const slugByCode = new Map(args.providers.map((p) => [p.code, p.providerSlug]));

  const order =
    args.chainOrder ??
    resolvePinnedLlmChain(args.pinned, args.providers) ??
    buildCombinedLlmPool(args.providers, args.largeContext ?? false);

  const filtered = order.filter((code) => !isGroqModelRateLimited(args.tenantId, code));
  const usable = filtered.length > 0 ? filtered : [...order];

  const entries: { model: string; providerSlug: string; maxRetries: number }[] = [];
  for (const code of usable) {
    const providerCode = providerCodeForModel(code);
    const slug = providerCode ? slugByCode.get(providerCode) : undefined;
    if (!slug) continue;
    entries.push({ model: code, providerSlug: slug, maxRetries: 1 });
  }
  return entries;
}
