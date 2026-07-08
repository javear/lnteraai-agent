// tenant_knowledge_usage: running byte total against each tenant's knowledge-base cap, plus the
// FalkorDB graph lifecycle fields (eviction/rebuild) — see sweep-knowledge-eviction.ts.
import { getSupabase } from '../shared/supabase';

const TABLE = 'tenant_knowledge_usage';

export interface TenantKnowledgeUsage {
  tenant_id: string;
  bytes_used: number;
  byte_limit: number;
  graph_evicted_at: string | null;
  last_activity_at: string;
}

async function ensureUsageRow(tenantId: string): Promise<TenantKnowledgeUsage> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to initialize knowledge usage for tenant ${tenantId}: ${error.message}`);
  if (data) return data as TenantKnowledgeUsage;

  // ignoreDuplicates on an existing row returns no row — fetch it.
  const { data: existing, error: fetchErr } = await supabase.from(TABLE).select('*').eq('tenant_id', tenantId).single();
  if (fetchErr || !existing) {
    throw new Error(`Failed to read knowledge usage for tenant ${tenantId}: ${fetchErr?.message ?? 'not found'}`);
  }
  return existing as TenantKnowledgeUsage;
}

export async function getKnowledgeUsage(tenantId: string): Promise<TenantKnowledgeUsage> {
  return ensureUsageRow(tenantId);
}

/**
 * Throws if adding `addedBytes` would push the tenant over its knowledge-base cap.
 * Call BEFORE starting ingestion (upload, or a save-knowledge tool call) — not after.
 */
export async function checkQuota(tenantId: string, addedBytes: number): Promise<TenantKnowledgeUsage> {
  const usage = await ensureUsageRow(tenantId);
  if (usage.bytes_used + addedBytes > usage.byte_limit) {
    const remaining = Math.max(0, usage.byte_limit - usage.bytes_used);
    throw new Error(
      `Knowledge base limit reached: ${remaining} bytes remaining of ${usage.byte_limit}, this would add ${addedBytes}.`,
    );
  }
  return usage;
}

/** Adjust the running byte total by `deltaBytes` (positive on ingest, negative on delete). */
export async function recordUsageDelta(tenantId: string, deltaBytes: number): Promise<void> {
  await ensureUsageRow(tenantId);
  const supabase = getSupabase();
  const { error } = await supabase.rpc('increment_tenant_knowledge_bytes', {
    p_tenant_id: tenantId,
    p_delta: deltaBytes,
  });
  if (error) throw new Error(`Failed to update knowledge usage for tenant ${tenantId}: ${error.message}`);
}

/** Bump `last_activity_at` to now — called whenever a tenant touches their knowledge base. */
export async function touchActivity(tenantId: string): Promise<void> {
  await ensureUsageRow(tenantId);
  const supabase = getSupabase();
  const { error } = await supabase
    .from(TABLE)
    .update({ last_activity_at: new Date().toISOString() })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to record activity for tenant ${tenantId}: ${error.message}`);
}
