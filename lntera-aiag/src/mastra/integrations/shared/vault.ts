import { getSupabase } from './supabase';

export type VaultSecretRef = {
  type: 'id' | 'name';
  value: string;
};

/**
 * Fetch decrypted Vault secret content as JSON via Postgres RPC (service_role only).
 */
export async function resolveIntegrationVaultSecret(
  ref: VaultSecretRef,
): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('resolve_integration_vault_secret', {
    p_ref_type: ref.type,
    p_ref_value: ref.value,
  });

  if (error) {
    throw new Error(`Failed to resolve Vault secret (${ref.type}): ${error.message}`);
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Vault secret resolved to an invalid payload.');
  }

  return data as Record<string, unknown>;
}
