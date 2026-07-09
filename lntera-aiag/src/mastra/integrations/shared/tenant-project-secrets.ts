import { getSupabase } from './supabase';
import { createIntegrationVaultSecret, resolveIntegrationVaultSecret, updateIntegrationVaultSecret } from './vault';
import type { TenantProjectSecret } from './types';

const TABLE = 'tenant_project_secrets';

/** A real env-var-style name — enforced before a secret ever touches Vault, since the same string
 *  gets written verbatim into the sandbox's env and (later) EdgeOne's env store. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** List a project's secrets — names + descriptions only, never values (for the "configured secrets" UI). */
export async function listTenantProjectSecrets(projectId: string): Promise<TenantProjectSecret[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to list project secrets (${projectId}): ${error.message}`);
  return (data ?? []) as TenantProjectSecret[];
}

/** Create or update (by name) a project's secret. The plaintext only ever passes through this
 *  function on its way into Vault — it's never persisted in `tenant_project_secrets` itself. */
export async function upsertTenantProjectSecret(
  projectId: string,
  input: { name: string; value: string; description?: string },
): Promise<TenantProjectSecret> {
  if (!SECRET_NAME_RE.test(input.name)) {
    throw new Error(`Invalid secret name "${input.name}" — must look like an env var, e.g. SHOPEE_API_KEY.`);
  }

  const supabase = getSupabase();
  const { data: existing, error: findError } = await supabase
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .eq('name', input.name)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up secret "${input.name}": ${findError.message}`);

  if (existing) {
    await updateIntegrationVaultSecret((existing as TenantProjectSecret).secret_ref, { value: input.value });
    const { data, error } = await supabase
      .from(TABLE)
      .update({ description: input.description ?? (existing as TenantProjectSecret).description })
      .eq('id', (existing as TenantProjectSecret).id)
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to update secret "${input.name}": ${error?.message ?? 'unknown error'}`);
    return data as TenantProjectSecret;
  }

  const ref = await createIntegrationVaultSecret(`studio:secret:${projectId}:${input.name}`, { value: input.value });
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ project_id: projectId, name: input.name, description: input.description ?? null, secret_ref: ref })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to save secret "${input.name}": ${error?.message ?? 'unknown error'}`);
  return data as TenantProjectSecret;
}

/** Resolve every secret for a project to its plaintext value — the one point where these leave Vault.
 *  Callers must not persist or log the result; it's handed to the tenant's own sandbox/deploy only. */
export async function resolveTenantProjectSecretValues(projectId: string): Promise<Record<string, string>> {
  const rows = await listTenantProjectSecrets(projectId);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const secret = await resolveIntegrationVaultSecret(row.secret_ref);
    if (typeof secret.value === 'string') out[row.name] = secret.value;
  }
  return out;
}
