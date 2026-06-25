-- Phase 5: per-tenant tax configuration (no static config — every business differs). Drives tax recaps
-- and (later) Coretax export. `config` is intentionally a flexible jsonb document, e.g.:
--   { "ppnEnabled": true, "ppnRate": 11, "withholding": [{ "type": "PPh23", "rate": 2 }] }
create table if not exists tenant_tax_config (
  tenant_id uuid primary key,
  npwp text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
