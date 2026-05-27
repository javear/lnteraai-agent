import { getSupabase } from './supabase';
import type { IntegrationCode, TenantIntegration, Uuid } from './types';
import { isIntegrationCode } from './types';

const TABLE = 'tenant_integrations';

function assertIntegrationCode(value: string): asserts value is IntegrationCode {
  if (!isIntegrationCode(value)) {
    throw new Error(`Unexpected integration_code "${value}"`);
  }
}

export async function listTenantIntegrationsByCode(
  integrationCode: IntegrationCode,
): Promise<TenantIntegration[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('integration_code', integrationCode)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list tenant integrations (${integrationCode}): ${error.message}`);
  }

  const rows = data ?? [];
  for (const row of rows) {
    assertIntegrationCode(String((row as { integration_code: string }).integration_code));
  }

  return rows as TenantIntegration[];
}

export async function getTenantIntegration(
  tenantId: Uuid,
  integrationCode: IntegrationCode,
): Promise<TenantIntegration | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('integration_code', integrationCode)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to read tenant integration (${tenantId}/${integrationCode}): ${error.message}`,
    );
  }

  if (!data) return null;

  assertIntegrationCode(String((data as { integration_code: string }).integration_code));
  return data as TenantIntegration;
}

/**
 * Returns another tenant's `discord` row if `guildId` + `channelId` already map to a different tenant.
 * Used to enforce unique Discord linkage per channel when upserting integration config.
 */
export async function findDiscordIntegrationConflictForRouting(input: {
  guildId: string;
  channelId: string;
  excludeTenantId: Uuid;
}): Promise<TenantIntegration | null> {
  const rows = await listTenantIntegrationsByCode('discord');
  for (const row of rows) {
    if (row.tenant_id === input.excludeTenantId) continue;
    const cfg = row.config as Record<string, unknown>;
    const g =
      typeof cfg.guildId === 'string'
        ? cfg.guildId
        : typeof (cfg.routing as Record<string, unknown> | undefined)?.guildId === 'string'
          ? String((cfg.routing as Record<string, unknown>).guildId)
          : undefined;
    const ch =
      typeof cfg.channelId === 'string'
        ? cfg.channelId
        : typeof (cfg.routing as Record<string, unknown> | undefined)?.channelId === 'string'
          ? String((cfg.routing as Record<string, unknown>).channelId)
          : undefined;
    if (g === input.guildId && ch === input.channelId) {
      return row;
    }
  }
  return null;
}

export async function upsertTenantIntegration(input: {
  tenant_id: Uuid;
  integration_code: IntegrationCode;
  config: Record<string, unknown>;
}): Promise<TenantIntegration> {
  const row = {
    tenant_id: input.tenant_id,
    integration_code: input.integration_code,
    config: input.config,
  };

  const { data, error } = await getSupabase()
    .from(TABLE)
    .upsert(row, { onConflict: 'tenant_id,integration_code' })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to upsert tenant integration: ${error?.message ?? 'unknown error'}`);
  }

  assertIntegrationCode(String((data as { integration_code: string }).integration_code));
  return data as TenantIntegration;
}
