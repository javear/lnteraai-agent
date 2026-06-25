// Per-tenant tax configuration (Phase 5). Flexible by design — what applies depends on the business.
// Drives tax recaps now; tax-aware posting (PPN split, per-supplier bukti potong) + Coretax export are
// layered on top once a tenant's config + a Coretax import sample are confirmed.
import { getSupabase } from '../shared/supabase';

export interface WithholdingRule {
  type: string; // PPh21 | PPh22 | PPh23 | PPh4(2) | PPh25
  rate?: number; // percent
}

export interface TaxConfig {
  ppnEnabled?: boolean;
  ppnRate?: number; // percent, e.g. 11
  withholding?: WithholdingRule[];
  [k: string]: unknown;
}

export interface TenantTaxConfig {
  npwp: string | null;
  config: TaxConfig;
}

export async function getTaxConfig(tenantId: string): Promise<TenantTaxConfig> {
  const { data, error } = await getSupabase()
    .from('tenant_tax_config')
    .select('npwp, config')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read tax config: ${error.message}`);
  if (!data) return { npwp: null, config: {} };
  const r = data as { npwp: string | null; config: TaxConfig | null };
  return { npwp: r.npwp ?? null, config: r.config ?? {} };
}

/** Merge-patch the tenant's tax config (config keys are shallow-merged). */
export async function setTaxConfig(
  tenantId: string,
  patch: { npwp?: string | null; config?: TaxConfig },
): Promise<TenantTaxConfig> {
  const supabase = getSupabase();
  const current = await getTaxConfig(tenantId);
  const next: TenantTaxConfig = {
    npwp: patch.npwp !== undefined ? patch.npwp : current.npwp,
    config: { ...current.config, ...(patch.config ?? {}) },
  };
  const { data: existing } = await supabase
    .from('tenant_tax_config')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from('tenant_tax_config')
      .update({ npwp: next.npwp, config: next.config, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId);
    if (error) throw new Error(`Failed to update tax config: ${error.message}`);
  } else {
    const { error } = await supabase.from('tenant_tax_config').insert({ tenant_id: tenantId, npwp: next.npwp, config: next.config });
    if (error) throw new Error(`Failed to create tax config: ${error.message}`);
  }
  return next;
}
