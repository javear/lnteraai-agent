import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  MarketplaceConnection,
  Platform,
  TenantMaster,
  UpdateTokensInput,
  UpsertConnectionInput,
  Uuid,
} from './types';

const TABLE = 'marketplace_connections';
const TENANTS_TABLE = 'tenant_master';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  // Prefer the new "Secret key" (sb_secret_...) over the legacy service_role JWT.
  // Either is accepted; SUPABASE_SECRET_KEY wins if both are set.
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in your .env.',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Browser-safe Supabase key for client-side auth (the `/auth` page) and for
 * `MastraAuthSupabase` token validation. Prefers the modern publishable key
 * (`sb_publishable_...`) over the legacy `anon` JWT, mirroring the secret-key precedence.
 */
export function getSupabasePublishableKey(): string | null {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    null
  );
}

/**
 * Server-side Supabase URL + service key, for direct REST calls that the JS client doesn't wrap
 * (e.g. the Realtime broadcast endpoint). Returns null when Supabase isn't configured so callers
 * can degrade gracefully instead of throwing.
 */
export function getSupabaseServiceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

export async function getConnection(
  platform: Platform,
  externalShopId: string,
): Promise<MarketplaceConnection | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('platform', platform)
    .eq('external_shop_id', externalShopId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read connection (${platform}/${externalShopId}): ${error.message}`);
  }
  return (data as MarketplaceConnection | null) ?? null;
}

export async function requireConnection(
  platform: Platform,
  externalShopId: string,
): Promise<MarketplaceConnection> {
  const conn = await getConnection(platform, externalShopId);
  if (!conn) {
    throw new Error(
      `No ${platform} connection found for shop "${externalShopId}". Complete the OAuth flow first.`,
    );
  }
  return conn;
}

/**
 * List marketplace_connections for a tenant, optionally filtered by platforms.
 * Returns rows ordered by platform then created_at ASC for stable iteration.
 */
export async function listConnectionsByTenant(
  tenantId: Uuid,
  platforms?: Platform[],
): Promise<MarketplaceConnection[]> {
  let query = getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .order('platform', { ascending: true })
    .order('created_at', { ascending: true });

  if (platforms && platforms.length > 0) {
    query = query.in('platform', platforms);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list connections for tenant ${tenantId}: ${error.message}`);
  }
  return (data as MarketplaceConnection[] | null) ?? [];
}

export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<MarketplaceConnection> {
  if (!input.tenant_id) {
    throw new Error('tenant_id is required when upserting marketplace connections.');
  }
  const row = {
    platform: input.platform,
    external_shop_id: input.external_shop_id,
    shop_name: input.shop_name ?? null,
    region: input.region ?? null,
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    access_token_expires_at: input.access_token_expires_at.toISOString(),
    refresh_token_expires_at: input.refresh_token_expires_at?.toISOString() ?? null,
    scope: input.scope ?? null,
    shop_cipher: input.shop_cipher ?? null,
    raw_metadata: input.raw_metadata ?? null,
    tenant_id: input.tenant_id,
  };

  const { data, error } = await getSupabase()
    .from(TABLE)
    .upsert(row, { onConflict: 'platform,external_shop_id' })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to upsert connection: ${error?.message ?? 'unknown error'}`);
  }
  return data as MarketplaceConnection;
}

/** Delete a tenant's marketplace connections for one platform (disconnect). Returns rows removed. */
export async function deleteConnectionsByTenant(
  tenantId: Uuid,
  platform: Platform,
): Promise<number> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .delete()
    .eq('tenant_id', tenantId)
    .eq('platform', platform)
    .select('id');
  if (error) {
    throw new Error(`Failed to delete ${platform} connections for tenant ${tenantId}: ${error.message}`);
  }
  return (data as unknown[] | null)?.length ?? 0;
}

export async function getTenantById(id: Uuid): Promise<TenantMaster | null> {
  const { data, error } = await getSupabase()
    .from(TENANTS_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read tenant by id (${id}): ${error.message}`);
  }
  return (data as TenantMaster | null) ?? null;
}

export async function getTenantBySlug(slug: string): Promise<TenantMaster | null> {
  const { data, error } = await getSupabase()
    .from(TENANTS_TABLE)
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read tenant by slug (${slug}): ${error.message}`);
  }
  return (data as TenantMaster | null) ?? null;
}

export async function resolveTenantId(tenantIdentifier: string): Promise<Uuid> {
  const ident = tenantIdentifier.trim();
  if (!ident) {
    throw new Error('tenant identifier is empty.');
  }
  if (UUID_RE.test(ident)) {
    const tenant = await getTenantById(ident);
    if (!tenant) {
      throw new Error(`Tenant id "${ident}" does not exist.`);
    }
    return tenant.id;
  }

  const tenant = await getTenantBySlug(ident);
  if (!tenant) {
    throw new Error(`Tenant slug "${ident}" does not exist.`);
  }
  return tenant.id;
}

export async function updateTokens(
  platform: Platform,
  externalShopId: string,
  tokens: UpdateTokensInput,
): Promise<MarketplaceConnection> {
  const patch: Record<string, unknown> = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: tokens.access_token_expires_at.toISOString(),
  };
  if (tokens.refresh_token_expires_at !== undefined) {
    patch.refresh_token_expires_at = tokens.refresh_token_expires_at?.toISOString() ?? null;
  }
  if (tokens.raw_metadata !== undefined) {
    patch.raw_metadata = tokens.raw_metadata;
  }

  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(patch)
    .eq('platform', platform)
    .eq('external_shop_id', externalShopId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to update tokens: ${error?.message ?? 'unknown error'}`);
  }
  return data as MarketplaceConnection;
}

/** Update display fields / metadata without touching OAuth tokens. */
export async function patchConnectionProfile(
  platform: Platform,
  externalShopId: string,
  patch: {
    shop_name?: string | null;
    region?: string | null;
    raw_metadata?: Record<string, unknown> | null;
  },
): Promise<MarketplaceConnection> {
  const row: Record<string, unknown> = {};
  if (patch.shop_name !== undefined) row.shop_name = patch.shop_name;
  if (patch.region !== undefined) row.region = patch.region;
  if (patch.raw_metadata !== undefined) row.raw_metadata = patch.raw_metadata;

  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(row)
    .eq('platform', platform)
    .eq('external_shop_id', externalShopId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to patch connection profile: ${error?.message ?? 'unknown error'}`);
  }
  return data as MarketplaceConnection;
}
