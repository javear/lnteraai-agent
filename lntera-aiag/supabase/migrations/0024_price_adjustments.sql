-- Dynamic per-store price adjustments.
--
-- Replaces the fixed up%/other%/flat triplet with a flexible list the seller can extend: each entry is
-- {"kind":"percent"|"fixed","value":<number>,"label":<optional string>}. The pushed price is
--   base × (1 + Σpercent/100) + Σfixed   (fixed added only when fee_currency matches the SKU currency).
--
-- The legacy columns (price_fee_flat / price_fee_up_pct / price_fee_other_pct) are kept so existing rows
-- keep working: when price_adjustments is empty they're synthesized into the list on read. New saves write
-- the list and zero the legacy columns.
alter table tenant_sync_prefs
  add column if not exists price_adjustments jsonb not null default '[]'::jsonb;
