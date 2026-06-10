import { getTenantIntegration } from '../shared/tenant-integrations';
import {
  groqTenantIntegrationConfigSchema,
  type GroqTenantIntegrationConfig,
  type LlmProviderIntegrationConfig,
  type Uuid,
} from '../shared/types';
import {
  LLM_PROVIDER_CODES,
  type LlmProviderCode,
} from '../../models/llm-providers';
import type { ActiveLlmProvider } from '../../models/llm-model-chain';

const CACHE_TTL_MS = 60_000;

type CacheEntry = {
  config: LlmProviderIntegrationConfig | null;
  expiresAt: number;
};

/** Keyed by `${tenantId}:${providerCode}`. */
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, code: LlmProviderCode): string {
  return `${tenantId}:${code}`;
}

function parseConfig(raw: unknown): LlmProviderIntegrationConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = groqTenantIntegrationConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Invalidate one provider's cache (or all of a tenant's when `code` is omitted). */
export function invalidateTenantProviderConfigCache(tenantId: string, code?: LlmProviderCode): void {
  if (code) {
    cache.delete(cacheKey(tenantId, code));
    return;
  }
  for (const c of LLM_PROVIDER_CODES) cache.delete(cacheKey(tenantId, c));
}

export async function resolveTenantProviderConfig(
  tenantId: string | null | undefined,
  code: LlmProviderCode,
): Promise<LlmProviderIntegrationConfig | null> {
  if (!tenantId) return null;

  const now = Date.now();
  const key = cacheKey(tenantId, code);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.config;

  const row = await getTenantIntegration(tenantId as Uuid, code);
  const config = row ? parseConfig(row.config) : null;

  cache.set(key, { config, expiresAt: now + CACHE_TTL_MS });
  return config;
}

export function isTenantProviderActive(
  config: LlmProviderIntegrationConfig | null | undefined,
): config is LlmProviderIntegrationConfig {
  return config?.status === 'active' && Boolean(config.portkeyProviderSlug);
}

/** All providers the tenant has actively connected, with their Portkey provider slug. */
export async function resolveActiveTenantProviders(
  tenantId: string | null | undefined,
): Promise<ActiveLlmProvider[]> {
  if (!tenantId) return [];
  const resolved = await Promise.all(
    LLM_PROVIDER_CODES.map(async (code) => {
      const config = await resolveTenantProviderConfig(tenantId, code).catch(() => null);
      return isTenantProviderActive(config)
        ? ({ code, providerSlug: config.portkeyProviderSlug } satisfies ActiveLlmProvider)
        : null;
    }),
  );
  return resolved.filter((p): p is ActiveLlmProvider => p !== null);
}

// ── Groq-specific back-compat wrappers (existing callers) ──────────────────────────────

export function invalidateTenantGroqConfigCache(tenantId: string): void {
  invalidateTenantProviderConfigCache(tenantId, 'groq');
}

export async function resolveTenantGroqConfig(
  tenantId: string | null | undefined,
): Promise<GroqTenantIntegrationConfig | null> {
  return resolveTenantProviderConfig(tenantId, 'groq');
}

export function isTenantGroqActive(
  config: GroqTenantIntegrationConfig | null | undefined,
): config is GroqTenantIntegrationConfig {
  return isTenantProviderActive(config);
}

export async function requireActiveTenantGroqConfig(
  tenantId: string,
): Promise<GroqTenantIntegrationConfig> {
  const config = await resolveTenantGroqConfig(tenantId);
  if (!isTenantGroqActive(config)) {
    throw new TenantGroqNotConfiguredError(tenantId);
  }
  return config;
}

export class TenantGroqNotConfiguredError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Tenant ${tenantId} has no active Groq integration.`);
    this.name = 'TenantGroqNotConfiguredError';
    this.tenantId = tenantId;
  }
}
