-- Extends tenant_sync_prefs (0014) for the bidirectional-sync feature, reusing its existing
-- default-row (marketplace_connection_id IS NULL) vs per-connection-override idiom:
--   * Autopilot prefs live on the tenant-DEFAULT row (autopilot_stock/price, propagate_mode).
--   * Per-store one-directional transforms live on the per-CONNECTION rows (price margin + stock cap).
-- A column is simply unused on the row type that doesn't apply to it (defaults are harmless there).

alter table tenant_sync_prefs
  add column if not exists autopilot_stock boolean not null default false,
  add column if not exists autopilot_price boolean not null default false,
  add column if not exists propagate_mode text not null default 'notify',
  add column if not exists price_fee_flat numeric(18, 4) not null default 0,
  add column if not exists price_fee_up_pct numeric(7, 4) not null default 0,
  add column if not exists price_fee_other_pct numeric(7, 4) not null default 0,
  add column if not exists fee_currency text,
  add column if not exists stock_cap_pct numeric(5, 2) not null default 100;

alter table tenant_sync_prefs drop constraint if exists tenant_sync_prefs_propagate_mode_chk;
alter table tenant_sync_prefs add constraint tenant_sync_prefs_propagate_mode_chk
  check (propagate_mode in ('notify', 'autopilot'));

alter table tenant_sync_prefs drop constraint if exists tenant_sync_prefs_stock_cap_chk;
alter table tenant_sync_prefs add constraint tenant_sync_prefs_stock_cap_chk
  check (stock_cap_pct > 0 and stock_cap_pct <= 100);

alter table tenant_sync_prefs drop constraint if exists tenant_sync_prefs_fees_nonneg_chk;
alter table tenant_sync_prefs add constraint tenant_sync_prefs_fees_nonneg_chk
  check (price_fee_flat >= 0 and price_fee_up_pct >= 0 and price_fee_other_pct >= 0);
