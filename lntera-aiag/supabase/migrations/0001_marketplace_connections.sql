-- Stores OAuth connection state for each authorized seller shop on each marketplace.
-- Run this once against your Supabase project (SQL Editor or via `supabase db push`).

create table if not exists marketplace_connections (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('shopee', 'tiktok')),
  external_shop_id text not null,
  shop_name text,
  region text,
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  scope text,
  raw_metadata jsonb,
  tenant_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_shop_id)
);

create index if not exists marketplace_connections_tenant_idx
  on marketplace_connections (tenant_id);

create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists marketplace_connections_set_updated_at on marketplace_connections;
create trigger marketplace_connections_set_updated_at
  before update on marketplace_connections
  for each row execute function set_updated_at();
