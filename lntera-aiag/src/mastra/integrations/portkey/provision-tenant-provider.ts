import type { LlmProviderIntegrationConfig, TenantMaster } from '../shared/types';
import { getLlmProvider, type LlmProviderCode } from '../../models/llm-providers';
import {
  createPortkeyIntegration,
  createPortkeyProvider,
  PortkeyAdminError,
  retrievePortkeyIntegrationBySlug,
  retrievePortkeyProviderBySlug,
  updatePortkeyIntegration,
  validateProviderViaPortkey,
} from './client';
import { getPortkeyInferenceApiKey } from './config';
import {
  derivePortkeyIntegrationSlugFor,
  derivePortkeyName,
  derivePortkeyProviderSlugFor,
} from './slugs';

export interface ProvisionTenantProviderResult {
  config: LlmProviderIntegrationConfig;
}

/**
 * Carries whatever Portkey state we managed to create before failing, so the caller can persist
 * it (ids/slugs) — making a later retry or disconnect able to reconcile/clean up.
 */
export class ProviderProvisionError extends Error {
  constructor(
    message: string,
    readonly partial: Partial<LlmProviderIntegrationConfig>,
  ) {
    super(message);
    this.name = 'ProviderProvisionError';
  }
}

/**
 * Clean a user-typed model list into Portkey segments: trim, drop blanks, dedupe (case-sensitive).
 * A leading `${code}/` is stripped so both `gpt-4o` and `openai/gpt-4o` normalize to the segment
 * — but internal slashes (OpenRouter's `anthropic/claude-3.5-sonnet`) are preserved.
 */
export function normalizeSelectedModels(models: string[] | undefined, code?: string): string[] {
  if (!models) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    let seg = String(raw).trim();
    if (!seg) continue;
    if (code && seg.toLowerCase().startsWith(`${code.toLowerCase()}/`)) {
      seg = seg.slice(code.length + 1);
    }
    if (!seg || seen.has(seg)) continue;
    seen.add(seg);
    out.push(seg);
  }
  return out;
}

function isDuplicate(err: unknown): boolean {
  // Portkey returns 409 OR 400 when a slug already exists.
  return err instanceof PortkeyAdminError && (err.status === 409 || err.status === 400);
}

/** Slugs Portkey will use for a tenant + provider (deterministic; safe to call before provisioning). */
export function deriveProviderSlugs(
  tenant: Pick<TenantMaster, 'slug' | 'id'>,
  code: LlmProviderCode,
): { portkeyProviderSlug: string; portkeyIntegrationSlug: string } {
  return {
    portkeyProviderSlug: derivePortkeyProviderSlugFor(tenant, code),
    portkeyIntegrationSlug: derivePortkeyIntegrationSlugFor(tenant, code),
  };
}

/**
 * Idempotent provisioning of a tenant's BYO LLM provider via Portkey, converging from ANY partial
 * state: integration (key store) → create or reuse+refresh; provider (router) → create or reuse;
 * then validate end-to-end. On failure throws {@link ProviderProvisionError} with the ids/slugs
 * created so far. Works for any provider in the registry (Groq, Gemini, …).
 */
export async function provisionTenantProvider(input: {
  tenant: TenantMaster;
  code: LlmProviderCode;
  apiKey: string;
  skipValidation?: boolean;
  /** Provider-relative model segments the tenant may use. Required for advanced/BYOK providers. */
  selectedModels?: string[];
}): Promise<ProvisionTenantProviderResult> {
  const def = getLlmProvider(input.code);
  if (!def) throw new Error(`Unknown LLM provider: ${input.code}`);

  const apiKey = input.apiKey.trim();
  if (!def.validateKey(apiKey)) {
    throw new Error(`Invalid ${def.displayName} API key format. Expected a key like ${def.keyHint}.`);
  }

  // BYOK providers ship no curated models — the tenant must supply the ones they may use, and we
  // validate the key against the first of them (free providers use their fixed validationModel).
  const selectedModels = normalizeSelectedModels(input.selectedModels, input.code);
  if (def.tier === 'advanced' && selectedModels.length === 0) {
    throw new Error(`Select at least one ${def.displayName} model code to connect.`);
  }
  const validationModel = def.validationModel ?? selectedModels[0];

  const { portkeyProviderSlug, portkeyIntegrationSlug } = deriveProviderSlugs(input.tenant, input.code);
  const integrationName = derivePortkeyName(input.tenant, def.displayName);
  const providerName = derivePortkeyName(input.tenant, `${def.displayName} LLM`);

  const partial: Partial<LlmProviderIntegrationConfig> = {
    portkeyProviderSlug,
    portkeyIntegrationSlug,
  };

  try {
    // 1) Integration — create, or reuse the existing one (refreshing its key).
    let integration: { id: string; slug: string } | null;
    try {
      integration = await createPortkeyIntegration({
        name: integrationName,
        slug: portkeyIntegrationSlug,
        apiKey,
        aiProviderId: def.portkeyAiProviderId,
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const existing = await retrievePortkeyIntegrationBySlug(portkeyIntegrationSlug).catch(() => null);
      if (existing?.id) {
        await updatePortkeyIntegration({ integrationId: existing.id, apiKey });
        integration = existing;
      } else {
        integration = { id: '', slug: portkeyIntegrationSlug };
      }
    }
    if (integration.id) partial.portkeyIntegrationId = integration.id;

    // 2) Provider — reuse existing, else create (bound to the integration slug).
    let provider = await retrievePortkeyProviderBySlug(portkeyProviderSlug).catch(() => null);
    if (!provider?.id) {
      try {
        provider = await createPortkeyProvider({
          name: providerName,
          slug: portkeyProviderSlug,
          integrationSlug: portkeyIntegrationSlug,
        });
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        provider = await retrievePortkeyProviderBySlug(portkeyProviderSlug).catch(() => null);
      }
    }
    if (!provider?.id) {
      throw new Error(`Failed to create or resolve Portkey provider for tenant ${def.displayName}.`);
    }
    partial.portkeyProviderId = provider.id;

    // 3) Validate the key end-to-end through Portkey inference. A quota/rate-limit (429) still
    //    means the key authenticated, so we connect anyway and just defer full validation.
    let rateLimited = false;
    if (!input.skipValidation && validationModel) {
      const result = await validateProviderViaPortkey({
        providerSlug: portkeyProviderSlug,
        model: validationModel,
        inferenceApiKey: getPortkeyInferenceApiKey(),
        providerLabel: def.displayName,
      });
      rateLimited = result.rateLimited;
    }

    const now = new Date().toISOString();
    const config: LlmProviderIntegrationConfig = {
      status: 'active',
      portkeyIntegrationSlug,
      portkeyProviderSlug,
      portkeyIntegrationId: integration.id || undefined,
      portkeyProviderId: provider.id,
      connectedAt: now,
      lastValidatedAt: input.skipValidation || rateLimited ? undefined : now,
      errorMessage: undefined,
      selectedModels: def.tier === 'advanced' ? selectedModels : undefined,
    };
    return { config };
  } catch (err) {
    throw new ProviderProvisionError(err instanceof Error ? err.message : String(err), partial);
  }
}

export async function revokeTenantProviderPortkey(input: {
  config: LlmProviderIntegrationConfig;
}): Promise<LlmProviderIntegrationConfig> {
  const { config } = input;
  const { deletePortkeyProvider, deletePortkeyIntegration } = await import('./client');

  let providerId = config.portkeyProviderId;
  if (!providerId && config.portkeyProviderSlug) {
    providerId = (await retrievePortkeyProviderBySlug(config.portkeyProviderSlug).catch(() => null))?.id;
  }
  if (providerId) {
    await deletePortkeyProvider(providerId).catch(() => undefined);
  }

  let integrationId = config.portkeyIntegrationId;
  if (!integrationId && config.portkeyIntegrationSlug) {
    integrationId = (await retrievePortkeyIntegrationBySlug(config.portkeyIntegrationSlug).catch(() => null))?.id;
  }
  if (integrationId) {
    await deletePortkeyIntegration(integrationId).catch(() => undefined);
  }

  return { ...config, status: 'revoked', errorMessage: undefined };
}
