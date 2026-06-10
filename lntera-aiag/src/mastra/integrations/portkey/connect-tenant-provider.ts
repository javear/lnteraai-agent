import { getTenantById, resolveTenantId } from '../shared/supabase';
import { getTenantIntegration, upsertTenantIntegration } from '../shared/tenant-integrations';
import type { LlmProviderIntegrationConfig } from '../shared/types';
import { groqTenantIntegrationConfigSchema } from '../shared/types';
import { getLlmProvider, type LlmProviderCode } from '../../models/llm-providers';
import { invalidateTenantProviderConfigCache } from './resolve-tenant-model';
import {
  deriveProviderSlugs,
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

  const parsed = groqTenantIntegrationConfigSchema.safeParse(row.config);
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
