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
}): Promise<ProvisionTenantProviderResult> {
  const def = getLlmProvider(input.code);
  if (!def) throw new Error(`Unknown LLM provider: ${input.code}`);

  const apiKey = input.apiKey.trim();
  if (!def.validateKey(apiKey)) {
    throw new Error(`Invalid ${def.displayName} API key format. Expected a key like ${def.keyHint}.`);
  }

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
    if (!input.skipValidation) {
      const result = await validateProviderViaPortkey({
        providerSlug: portkeyProviderSlug,
        model: def.validationModel,
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
