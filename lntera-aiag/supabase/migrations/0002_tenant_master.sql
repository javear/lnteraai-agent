-- Tenant master table: one business tenant can own many marketplace connections.

create table if not exists tenant_master (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  legal_name text,
  country_code text,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_master_slug_idx on tenant_master (slug);

-- Reuse the common updated_at trigger function.
drop trigger if exists tenant_master_set_updated_at on tenant_master;
create trigger tenant_master_set_updated_at
  before update on tenant_master
  for each row execute function set_updated_at();
