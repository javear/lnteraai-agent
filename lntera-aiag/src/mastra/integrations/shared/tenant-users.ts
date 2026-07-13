import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase';
import { ALL_TOOLS_WILDCARD, type Uuid } from './types';

const TENANTS_TABLE = 'tenant_master';
const ROLES_TABLE = 'tenant_roles';
const USERS_TABLE = 'tenant_users';

/**
 * Read-only tool subset granted to the seeded `member` role — demonstrates per-role
 * gating. Owners get `['*']` (all tools). Tool ids must match the agent's tool `.id`s.
 */
export const MEMBER_TOOL_IDS = [
  'list-marketplace-shops',
  'search-products',
  'search-orders',
  'get-order-details',
  'get-shipping-labels',
  'get-product-details',
  'get-product-draft',
  'list-product-drafts',
] as const;

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(3).toString('hex');
  return `${base || 'workspace'}-${suffix}`;
}

/** First active tenant membership for a Supabase auth user (POC: one user → one tenant). */
export async function getTenantUserForAuthUser(
  authUserId: string,
): Promise<{ tenantId: Uuid; role: string } | null> {
  const { data, error } = await getSupabase()
    .from(USERS_TABLE)
    .select('tenant_id, role')
    .eq('auth_user_id', authUserId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read tenant_users for ${authUserId}: ${error.message}`);
  }
  if (!data) return null;
  return { tenantId: (data as { tenant_id: Uuid }).tenant_id, role: (data as { role: string }).role };
}

/** The auth user's CURRENT email straight from Supabase Auth (not the possibly-stale copy captured
 *  on `tenant_users.email` at provisioning time). Returns null if the user can't be found. */
export async function getAuthUserEmail(authUserId: string): Promise<string | null> {
  const { data, error } = await getSupabase().auth.admin.getUserById(authUserId);
  if (error) throw new Error(`Failed to look up auth user ${authUserId}: ${error.message}`);
  return data.user?.email ?? null;
}

/** `allowed_tools` for a (tenant, role slug), or null when the role row doesn't exist. */
export async function getRoleAllowedTools(
  tenantId: Uuid,
  roleSlug: string,
): Promise<string[] | null> {
  const { data, error } = await getSupabase()
    .from(ROLES_TABLE)
    .select('allowed_tools')
    .eq('tenant_id', tenantId)
    .eq('slug', roleSlug)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read tenant_roles (${tenantId}/${roleSlug}): ${error.message}`);
  }
  if (!data) return null;
  return (data as { allowed_tools: string[] }).allowed_tools ?? [];
}

/**
 * Idempotently ensure the authenticated Supabase user owns a workspace.
 *
 * On first call: creates a `tenant_master`, seeds `owner` (all tools) + `member`
 * (read-only) roles, inserts the `tenant_users` owner row, and writes the tenant id
 * into the user's `app_metadata` so every subsequent access token carries it.
 */
export async function provisionWorkspaceForAuthUser(input: {
  authUserId: string;
  email?: string | null;
  workspaceName?: string | null;
}): Promise<{ tenantId: Uuid }> {
  const existing = await getTenantUserForAuthUser(input.authUserId);
  if (existing) return { tenantId: existing.tenantId };

  const supabase = getSupabase();
  const name = input.workspaceName?.trim() || input.email?.trim() || 'My Workspace';

  const { data: tenant, error: tenantErr } = await supabase
    .from(TENANTS_TABLE)
    .insert({ name, slug: slugify(name) })
    .select('id')
    .single();
  if (tenantErr || !tenant) {
    throw new Error(`Failed to create tenant: ${tenantErr?.message ?? 'unknown error'}`);
  }
  const tenantId = (tenant as { id: Uuid }).id;

  const { error: rolesErr } = await supabase.from(ROLES_TABLE).insert([
    { tenant_id: tenantId, slug: 'owner', name: 'Owner', allowed_tools: [ALL_TOOLS_WILDCARD], is_system: true },
    { tenant_id: tenantId, slug: 'member', name: 'Member', allowed_tools: [...MEMBER_TOOL_IDS], is_system: false },
  ]);
  if (rolesErr) {
    throw new Error(`Failed to seed tenant_roles: ${rolesErr.message}`);
  }

  const { error: userErr } = await supabase.from(USERS_TABLE).insert({
    tenant_id: tenantId,
    auth_user_id: input.authUserId,
    email: input.email ?? null,
    role: 'owner',
    status: 'active',
  });
  if (userErr) {
    throw new Error(`Failed to create tenant_users row: ${userErr.message}`);
  }

  // Surface the tenant in the JWT. app_metadata is server-controlled and included in
  // every Supabase access token automatically (no custom access-token hook needed).
  const { error: metaErr } = await supabase.auth.admin.updateUserById(input.authUserId, {
    app_metadata: { tenant_id: tenantId },
  });
  if (metaErr) {
    throw new Error(`Failed to set app_metadata.tenant_id: ${metaErr.message}`);
  }

  return { tenantId };
}
