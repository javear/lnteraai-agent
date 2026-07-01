import { getTenantById, resolveTenantId } from '../shared/supabase';
import { getTenantIntegration, upsertTenantIntegration } from '../shared/tenant-integrations';
import type { LlmProviderIntegrationConfig } from '../shared/types';
import { llmProviderIntegrationConfigSchema } from '../shared/types';
import { getLlmProvider, type LlmProviderCode } from '../../models/llm-providers';
import { invalidateTenantProviderConfigCache, resolveTenantProviderConfig } from './resolve-tenant-model';
import {
  deriveProviderSlugs,
  normalizeSelectedModels,
  ProviderProvisionError,
  provisionTenantProvider,
  revokeTenantProviderPortkey,
} from './provision-tenant-provider';

/** Connect (or reconnect) a tenant's BYO LLM provider key, provisioning it through Portkey. */
export async function connectTenantProvider(input: {
  tenantId: string;
  code: LlmProviderCode;
  apiKey: string;
  skipValidation?: boolean;
  /** Provider-relative model segments the tenant may use. Required for advanced/BYOK providers. */
  selectedModels?: string[];
}): Promise<LlmProviderIntegrationConfig> {
  const def = getLlmProvider(input.code);
  if (!def) throw new Error(`Unknown LLM provider: ${input.code}`);

  const tenantUuid = await resolveTenantId(input.tenantId);
  const tenant = await getTenantById(tenantUuid);
  if (!tenant) {
    throw new Error(`Tenant ${input.tenantId} not found.`);
  }

  try {
    const { config } = await provisionTenantProvider({
      tenant,
      code: input.code,
      apiKey: input.apiKey,
      skipValidation: input.skipValidation,
      selectedModels: input.selectedModels,
    });

    await upsertTenantIntegration({
      tenant_id: tenantUuid,
      integration_code: input.code,
      config: { ...config },
    });

    invalidateTenantProviderConfigCache(tenantUuid, input.code);
    return config;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Persist whatever Portkey state provisioning created, so a retry can reconcile and a
    // disconnect can clean it up (otherwise we'd orphan resources in Portkey).
    const partial = err instanceof ProviderProvisionError ? err.partial : {};
    const slugs = deriveProviderSlugs(tenant, input.code);
    const failedConfig: LlmProviderIntegrationConfig = {
      status: 'error',
      portkeyIntegrationSlug: partial.portkeyIntegrationSlug ?? slugs.portkeyIntegrationSlug,
      portkeyProviderSlug: partial.portkeyProviderSlug ?? slugs.portkeyProviderSlug,
      portkeyIntegrationId: partial.portkeyIntegrationId,
      portkeyProviderId: partial.portkeyProviderId,
      errorMessage,
    };
    await upsertTenantIntegration({
      tenant_id: tenantUuid,
      integration_code: input.code,
      config: { ...failedConfig },
    }).catch(() => undefined);
    invalidateTenantProviderConfigCache(tenantUuid, input.code);
    throw err;
  }
}

export async function disconnectTenantProvider(input: {
  tenantId: string;
  code: LlmProviderCode;
}): Promise<LlmProviderIntegrationConfig> {
  const def = getLlmProvider(input.code);
  if (!def) throw new Error(`Unknown LLM provider: ${input.code}`);

  const tenantUuid = await resolveTenantId(input.tenantId);
  const row = await getTenantIntegration(tenantUuid, input.code);
  if (!row) {
    throw new Error(`${def.displayName} integration not found for tenant.`);
  }

  const parsed = llmProviderIntegrationConfigSchema.safeParse(row.config);
  const existing = parsed.success ? parsed.data : null;
  const revoked = existing
    ? await revokeTenantProviderPortkey({ config: existing })
    : ({
        status: 'revoked' as const,
        portkeyIntegrationSlug: 'unknown',
        portkeyProviderSlug: 'unknown',
      } satisfies LlmProviderIntegrationConfig);

  await upsertTenantIntegration({
    tenant_id: tenantUuid,
    integration_code: input.code,
    config: { ...revoked },
  });

  invalidateTenantProviderConfigCache(tenantUuid, input.code);
  return revoked;
}

/**
 * Edit an advanced provider's allowed model list WITHOUT re-entering the key. The key lives in
 * Portkey and the Portkey integration/provider are untouched — we only rewrite `selectedModels`
 * on the stored config and bust the cache so the next agent run sees the new set.
 */
export async function updateTenantProviderModels(input: {
  tenantId: string;
  code: LlmProviderCode;
  selectedModels: string[];
}): Promise<LlmProviderIntegrationConfig> {
  const def = getLlmProvider(input.code);
  if (!def) throw new Error(`Unknown LLM provider: ${input.code}`);
  if (def.tier !== 'advanced') {
    throw new Error(`${def.displayName} does not support editing its model list.`);
  }

  const tenantUuid = await resolveTenantId(input.tenantId);
  const existing = await resolveTenantProviderConfig(tenantUuid, input.code);
  if (!existing || existing.status !== 'active') {
    throw new Error(`${def.displayName} is not connected for this tenant.`);
  }

  const selectedModels = normalizeSelectedModels(input.selectedModels, input.code);
  if (selectedModels.length === 0) {
    throw new Error(`Select at least one ${def.displayName} model code.`);
  }

  const config: LlmProviderIntegrationConfig = { ...existing, selectedModels };
  await upsertTenantIntegration({
    tenant_id: tenantUuid,
    integration_code: input.code,
    config: { ...config },
  });
  invalidateTenantProviderConfigCache(tenantUuid, input.code);
  return config;
}
