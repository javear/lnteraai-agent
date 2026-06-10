import { getTenantById, resolveTenantId } from '../shared/supabase';
import type { GroqTenantIntegrationConfig, TenantMaster } from '../shared/types';
import { connectTenantProvider, disconnectTenantProvider } from './connect-tenant-provider';

/** @deprecated Use {@link connectTenantProvider} with `code: 'groq'`. Kept for existing callers. */
export async function connectTenantGroq(input: {
  tenantId: string;
  groqApiKey: string;
  skipValidation?: boolean;
}): Promise<GroqTenantIntegrationConfig> {
  return connectTenantProvider({
    tenantId: input.tenantId,
    code: 'groq',
    apiKey: input.groqApiKey,
    skipValidation: input.skipValidation,
  });
}

/** @deprecated Use {@link disconnectTenantProvider} with `code: 'groq'`. */
export async function disconnectTenantGroq(tenantId: string): Promise<GroqTenantIntegrationConfig> {
  return disconnectTenantProvider({ tenantId, code: 'groq' });
}

export async function loadTenantForGroqOnboard(tenantInput: string): Promise<TenantMaster> {
  const tenantUuid = await resolveTenantId(tenantInput);
  const tenant = await getTenantById(tenantUuid);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantInput}`);
  }
  return tenant;
}
