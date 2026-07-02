import { getSupabase } from './supabase';
import {
  isProjectKind,
  type ProjectKind,
  type ProjectStatus,
  type TenantProject,
  type Uuid,
  type VaultSecretRefValue,
} from './types';

const TABLE = 'tenant_projects';

function assertProject(row: unknown): asserts row is TenantProject {
  const kind = (row as { kind?: string } | null)?.kind;
  if (typeof kind !== 'string' || !isProjectKind(kind)) {
    throw new Error(`Unexpected project kind "${String(kind)}"`);
  }
}

export async function listTenantProjects(tenantId: Uuid): Promise<TenantProject[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to list tenant projects (${tenantId}): ${error.message}`);
  const rows = data ?? [];
  for (const row of rows) assertProject(row);
  return rows as TenantProject[];
}

export async function getTenantProject(tenantId: Uuid, id: string): Promise<TenantProject | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Failed to read tenant project (${tenantId}/${id}): ${error.message}`);
  if (!data) return null;
  assertProject(data);
  return data as TenantProject;
}

/** The tenant's connected MCP project (kind='mcp', status='connected'), if any — for agent attachment. */
export async function getConnectedTenantMcpProject(tenantId: Uuid): Promise<TenantProject | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('kind', 'mcp')
    .eq('status', 'connected')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read connected MCP project (${tenantId}): ${error.message}`);
  if (!data) return null;
  assertProject(data);
  return data as TenantProject;
}

export async function createTenantProject(input: {
  tenant_id: Uuid;
  name: string;
  kind: ProjectKind;
  config?: Record<string, unknown>;
}): Promise<TenantProject> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      tenant_id: input.tenant_id,
      name: input.name,
      kind: input.kind,
      status: 'draft',
      config: input.config ?? {},
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create tenant project: ${error?.message ?? 'unknown error'}`);
  }
  assertProject(data);
  return data as TenantProject;
}

/** Partial update scoped to the tenant (guards against cross-tenant writes). */
export async function updateTenantProject(
  tenantId: Uuid,
  id: string,
  patch: Partial<{
    name: string;
    status: ProjectStatus;
    gitea_repo: string | null;
    deploy_url: string | null;
    mcp_url: string | null;
    gitea_secret_ref: VaultSecretRefValue | null;
    mcp_secret_ref: VaultSecretRefValue | null;
    config: Record<string, unknown>;
  }>,
): Promise<TenantProject> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to update tenant project (${tenantId}/${id}): ${error?.message ?? 'not found'}`);
  }
  assertProject(data);
  return data as TenantProject;
}

/** Delete a project row (tenant-scoped). Returns true if a row was removed. */
export async function deleteTenantProject(tenantId: Uuid, id: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .delete()
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`Failed to delete tenant project (${tenantId}/${id}): ${error.message}`);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}
