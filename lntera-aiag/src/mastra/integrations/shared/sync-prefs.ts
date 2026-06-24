// Resolves a tenant's product-sync automation prefs. Auto-create/auto-map/thresholds: a per-connection
// row overrides the tenant-default row (marketplace_connection_id IS NULL). Autopilot (stock/price +
// propagate_mode) is tenant-wide (read from the default row). Per-store transforms (price margin +
// stock cap) live on the per-connection row. See migrations 0014 + 0021.
import { getSupabase } from './supabase';
import type { PriceAdjustment } from '../../sync/store-transforms';

export type { PriceAdjustment };

export interface StoreTransform {
  /** Dynamic stack of price adjustments (percent + fixed). Canonical price config. */
  priceAdjustments: PriceAdjustment[];
  feeCurrency: string | null;
  stockCapPct: number;
}

export interface ResolvedSyncPrefs {
  autoCreateNew: boolean;
  autoMapHighConfidence: boolean;
  highThreshold: number;
  mediumThreshold: number;
  autopilotStock: boolean;
  autopilotPrice: boolean;
  propagateMode: 'notify' | 'autopilot';
  /** Per-store transform for the requested connection (defaults when no connectionId / no row). */
  transform: StoreTransform;
}

export const STORE_TRANSFORM_DEFAULTS: StoreTransform = {
  priceAdjustments: [],
  feeCurrency: null,
  stockCapPct: 100,
};

export const SYNC_PREF_DEFAULTS: ResolvedSyncPrefs = {
  autoCreateNew: false,
  autoMapHighConfidence: false,
  highThreshold: 0.9,
  mediumThreshold: 0.6,
  autopilotStock: false,
  autopilotPrice: false,
  propagateMode: 'notify',
  transform: { ...STORE_TRANSFORM_DEFAULTS },
};

interface SyncPrefRow {
  marketplace_connection_id: string | null;
  auto_create_new: boolean | null;
  auto_map_high_confidence: boolean | null;
  high_threshold: number | string | null;
  medium_threshold: number | string | null;
  autopilot_stock: boolean | null;
  autopilot_price: boolean | null;
  propagate_mode: string | null;
  price_fee_flat: number | string | null;
  price_fee_up_pct: number | string | null;
  price_fee_other_pct: number | string | null;
  price_adjustments: unknown;
  fee_currency: string | null;
  stock_cap_pct: number | string | null;
}

const COLS =
  'marketplace_connection_id, auto_create_new, auto_map_high_confidence, high_threshold, medium_threshold, ' +
  'autopilot_stock, autopilot_price, propagate_mode, price_fee_flat, price_fee_up_pct, price_fee_other_pct, ' +
  'price_adjustments, fee_currency, stock_cap_pct';

const num = (v: number | string | null | undefined, fallback: number): number => (v == null ? fallback : Number(v));

/** Coerce stored JSON into a clean PriceAdjustment[] (drop malformed entries). */
function parseAdjustments(raw: unknown): PriceAdjustment[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceAdjustment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const kind = o.kind === 'fixed' ? 'fixed' : o.kind === 'percent' ? 'percent' : null;
    const value = Number(o.value);
    if (!kind || !Number.isFinite(value)) continue;
    out.push({ kind, value, ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim() } : {}) });
  }
  return out;
}

/** Backward compat: synthesize the legacy up%/other%/flat triplet into the adjustments list. */
function legacyToAdjustments(r: SyncPrefRow): PriceAdjustment[] {
  const out: PriceAdjustment[] = [];
  const up = num(r.price_fee_up_pct, 0);
  const other = num(r.price_fee_other_pct, 0);
  const flat = num(r.price_fee_flat, 0);
  if (up) out.push({ kind: 'percent', value: up, label: 'Up' });
  if (other) out.push({ kind: 'percent', value: other, label: 'Other fee' });
  if (flat) out.push({ kind: 'fixed', value: flat, label: 'Flat fee' });
  return out;
}

function rowToTransform(r: SyncPrefRow | null): StoreTransform {
  if (!r) return { ...STORE_TRANSFORM_DEFAULTS, priceAdjustments: [] };
  const parsed = parseAdjustments(r.price_adjustments);
  return {
    // Prefer the dynamic list; fall back to the legacy columns for rows saved before migration 0024.
    priceAdjustments: parsed.length > 0 ? parsed : legacyToAdjustments(r),
    feeCurrency: r.fee_currency,
    stockCapPct: num(r.stock_cap_pct, 100),
  };
}

export async function resolveSyncPrefs(tenantId: string, connectionId?: string | null): Promise<ResolvedSyncPrefs> {
  const { data, error } = await getSupabase().from('tenant_sync_prefs').select(COLS).eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to read sync prefs for tenant ${tenantId}: ${error.message}`);

  const rows = (data as unknown as SyncPrefRow[] | null) ?? [];
  const tenantDefault = rows.find((r) => r.marketplace_connection_id == null) ?? null;
  const connRow = connectionId ? (rows.find((r) => r.marketplace_connection_id === connectionId) ?? null) : null;
  const pick = connRow ?? tenantDefault; // auto-create/map/thresholds: per-connection overrides default

  return {
    autoCreateNew: Boolean(pick?.auto_create_new),
    autoMapHighConfidence: Boolean(pick?.auto_map_high_confidence),
    highThreshold: num(pick?.high_threshold, SYNC_PREF_DEFAULTS.highThreshold),
    mediumThreshold: num(pick?.medium_threshold, SYNC_PREF_DEFAULTS.mediumThreshold),
    autopilotStock: Boolean(tenantDefault?.autopilot_stock),
    autopilotPrice: Boolean(tenantDefault?.autopilot_price),
    propagateMode: tenantDefault?.propagate_mode === 'autopilot' ? 'autopilot' : 'notify',
    transform: rowToTransform(connRow),
  };
}

/** All per-store transforms for a tenant, keyed by marketplace_connection_id (for the settings UI). */
export async function listStoreTransforms(tenantId: string): Promise<Map<string, StoreTransform>> {
  const { data, error } = await getSupabase().from('tenant_sync_prefs').select(COLS).eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to read store transforms: ${error.message}`);
  const out = new Map<string, StoreTransform>();
  for (const r of (data as unknown as SyncPrefRow[] | null) ?? []) {
    if (r.marketplace_connection_id) out.set(r.marketplace_connection_id, rowToTransform(r));
  }
  return out;
}

/** Read-then-write upsert of one prefs row (the unique indexes are PARTIAL → PostgREST can't infer them). */
async function upsertPrefRow(tenantId: string, connectionId: string | null, fields: Record<string, unknown>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const supabase = getSupabase();
  let lookup = supabase.from('tenant_sync_prefs').select('id').eq('tenant_id', tenantId);
  lookup = connectionId ? lookup.eq('marketplace_connection_id', connectionId) : lookup.is('marketplace_connection_id', null);
  const { data: existing, error: readErr } = await lookup.maybeSingle();
  if (readErr) throw new Error(`Failed to read sync prefs: ${readErr.message}`);

  if (existing) {
    const { error } = await supabase.from('tenant_sync_prefs').update(fields).eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`Failed to update sync prefs: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('tenant_sync_prefs')
      .insert({ tenant_id: tenantId, marketplace_connection_id: connectionId, ...fields });
    if (error) throw new Error(`Failed to insert sync prefs: ${error.message}`);
  }
}

export interface SyncPrefsPatch {
  autoCreateNew?: boolean;
  autoMapHighConfidence?: boolean;
  highThreshold?: number;
  mediumThreshold?: number;
  autopilotStock?: boolean;
  autopilotPrice?: boolean;
  propagateMode?: 'notify' | 'autopilot';
}

/** Set auto/autopilot/threshold prefs on the tenant-default row (or a per-connection override). */
export async function setSyncPrefs(tenantId: string, patch: SyncPrefsPatch, connectionId?: string | null): Promise<void> {
  const f: Record<string, unknown> = {};
  if (patch.autoCreateNew !== undefined) f.auto_create_new = patch.autoCreateNew;
  if (patch.autoMapHighConfidence !== undefined) f.auto_map_high_confidence = patch.autoMapHighConfidence;
  if (patch.highThreshold !== undefined) f.high_threshold = patch.highThreshold;
  if (patch.mediumThreshold !== undefined) f.medium_threshold = patch.mediumThreshold;
  if (patch.autopilotStock !== undefined) f.autopilot_stock = patch.autopilotStock;
  if (patch.autopilotPrice !== undefined) f.autopilot_price = patch.autopilotPrice;
  if (patch.propagateMode !== undefined) f.propagate_mode = patch.propagateMode;
  await upsertPrefRow(tenantId, connectionId ?? null, f);
}

/** Set a store's one-directional transform (price adjustments + stock cap) on its per-connection row. */
export async function setStoreSyncConfig(tenantId: string, connectionId: string, patch: Partial<StoreTransform>): Promise<void> {
  const f: Record<string, unknown> = {};
  if (patch.priceAdjustments !== undefined) {
    // The list is canonical now → persist it and zero the legacy columns so a later read never
    // resurrects stale up%/other%/flat values (e.g. when the seller clears all adjustments).
    f.price_adjustments = patch.priceAdjustments;
    f.price_fee_flat = 0;
    f.price_fee_up_pct = 0;
    f.price_fee_other_pct = 0;
  }
  if (patch.feeCurrency !== undefined) f.fee_currency = patch.feeCurrency;
  if (patch.stockCapPct !== undefined) f.stock_cap_pct = patch.stockCapPct;
  await upsertPrefRow(tenantId, connectionId, f);
}
