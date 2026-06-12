// Resolves a tenant's product-sync automation prefs: a per-connection row overrides the tenant
// default row (marketplace_connection_id IS NULL), which overrides hard-coded constants.
import { getSupabase } from './supabase';

export interface ResolvedSyncPrefs {
  autoCreateNew: boolean;
  autoMapHighConfidence: boolean;
  highThreshold: number;
  mediumThreshold: number;
}

export const SYNC_PREF_DEFAULTS: ResolvedSyncPrefs = {
  autoCreateNew: false,
  autoMapHighConfidence: false,
  highThreshold: 0.9,
  mediumThreshold: 0.6,
};

interface SyncPrefRow {
  marketplace_connection_id: string | null;
  auto_create_new: boolean | null;
  auto_map_high_confidence: boolean | null;
  high_threshold: number | string | null;
  medium_threshold: number | string | null;
}

export async function resolveSyncPrefs(
  tenantId: string,
  connectionId?: string | null,
): Promise<ResolvedSyncPrefs> {
  const { data, error } = await getSupabase()
    .from('tenant_sync_prefs')
    .select('marketplace_connection_id, auto_create_new, auto_map_high_confidence, high_threshold, medium_threshold')
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to read sync prefs for tenant ${tenantId}: ${error.message}`);

  const rows = (data as SyncPrefRow[] | null) ?? [];
  const tenantDefault = rows.find((r) => r.marketplace_connection_id == null) ?? null;
  const connRow = connectionId
    ? (rows.find((r) => r.marketplace_connection_id === connectionId) ?? null)
    : null;
  const pick = connRow ?? tenantDefault;
  if (!pick) return { ...SYNC_PREF_DEFAULTS };

  const num = (v: number | string | null, fallback: number) =>
    v == null ? fallback : Number(v);
  return {
    autoCreateNew: Boolean(pick.auto_create_new),
    autoMapHighConfidence: Boolean(pick.auto_map_high_confidence),
    highThreshold: num(pick.high_threshold, SYNC_PREF_DEFAULTS.highThreshold),
    mediumThreshold: num(pick.medium_threshold, SYNC_PREF_DEFAULTS.mediumThreshold),
  };
}

/**
 * Set auto flags on the tenant-default row (connectionId omitted) or a per-connection override.
 * Manual read-then-write upsert because the unique indexes are PARTIAL (PostgREST can't infer them).
 */
export async function setSyncPrefs(
  tenantId: string,
  patch: { autoCreateNew?: boolean; autoMapHighConfidence?: boolean },
  connectionId?: string | null,
): Promise<void> {
  const supabase = getSupabase();
  let lookup = supabase.from('tenant_sync_prefs').select('id').eq('tenant_id', tenantId);
  lookup = connectionId
    ? lookup.eq('marketplace_connection_id', connectionId)
    : lookup.is('marketplace_connection_id', null);
  const { data: existing, error: readErr } = await lookup.maybeSingle();
  if (readErr) throw new Error(`Failed to read sync prefs: ${readErr.message}`);

  const fields: Record<string, unknown> = {};
  if (patch.autoCreateNew !== undefined) fields.auto_create_new = patch.autoCreateNew;
  if (patch.autoMapHighConfidence !== undefined) fields.auto_map_high_confidence = patch.autoMapHighConfidence;

  if (existing) {
    const { error } = await supabase
      .from('tenant_sync_prefs')
      .update(fields)
      .eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`Failed to update sync prefs: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('tenant_sync_prefs')
      .insert({ tenant_id: tenantId, marketplace_connection_id: connectionId ?? null, ...fields });
    if (error) throw new Error(`Failed to insert sync prefs: ${error.message}`);
  }
}
