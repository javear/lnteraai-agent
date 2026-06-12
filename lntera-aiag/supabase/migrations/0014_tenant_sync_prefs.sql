-- Per-tenant product-sync automation prefs, optionally overridden per marketplace connection.
-- A row with marketplace_connection_id = NULL is the tenant-wide default; a row with a connection
-- id overrides it for that store. Both auto flags default OFF (always ask).

create table if not exists tenant_sync_prefs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  marketplace_connection_id uuid references marketplace_connections(id) on update cascade on delete cascade,
  auto_create_new boolean not null default false,
  auto_map_high_confidence boolean not null default false,
  high_threshold numeric(4, 3),                    -- default 0.900 if null
  medium_threshold numeric(4, 3),                  -- default 0.600 if null
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_sync_prefs_tenant_default_uq
  on tenant_sync_prefs (tenant_id) where marketplace_connection_id is null;
create unique index if not exists tenant_sync_prefs_conn_uq
  on tenant_sync_prefs (tenant_id, marketplace_connection_id) where marketplace_connection_id is not null;

drop trigger if exists tenant_sync_prefs_set_updated_at on tenant_sync_prefs;
create trigger tenant_sync_prefs_set_updated_at
  before update on tenant_sync_prefs
  for each row execute function set_updated_at();
