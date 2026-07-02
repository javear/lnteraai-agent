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

/**
 * Store a JSON payload as a new Vault secret (service_role only) and return a ref to it.
 * The returned ref ({ type: 'id', value }) is what callers persist in a `*_secret_ref` column —
 * the plaintext never leaves Vault.
 */
export async function createIntegrationVaultSecret(
  name: string,
  payload: Record<string, unknown>,
  description?: string,
): Promise<VaultSecretRef> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('create_integration_vault_secret', {
    p_name: name,
    p_payload: payload,
    ...(description ? { p_description: description } : {}),
  });

  if (error) {
    throw new Error(`Failed to create Vault secret (${name}): ${error.message}`);
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('Vault secret creation returned no id.');
  }

  return { type: 'id', value: data };
}

/** Rotate an existing Vault secret's JSON payload in place (its ref stays valid). */
export async function updateIntegrationVaultSecret(
  ref: VaultSecretRef,
  payload: Record<string, unknown>,
): Promise<void> {
  if (ref.type !== 'id') {
    throw new Error("updateIntegrationVaultSecret requires a ref of type 'id'.");
  }
  const supabase = getSupabase();
  const { error } = await supabase.rpc('update_integration_vault_secret', {
    p_id: ref.value,
    p_payload: payload,
  });
  if (error) {
    throw new Error(`Failed to update Vault secret (${ref.value}): ${error.message}`);
  }
}
