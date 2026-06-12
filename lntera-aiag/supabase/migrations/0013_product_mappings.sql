-- Maps a marketplace product (per connection) to an internal tenant_products row, with the
-- similarity match score + decision status. internal_product_id is NULL until mapped/created.
-- Unique on (connection, external_product_id) makes ingest/re-score idempotent.

create table if not exists product_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  internal_product_id uuid references tenant_products(id) on update cascade on delete set null,
  marketplace_connection_id uuid not null references marketplace_connections(id) on update cascade on delete cascade,
  platform text not null check (platform in ('shopee', 'tiktok')),
  external_product_id text not null,
  external_product_name text,                      -- the text used for similarity
  match_score numeric(6, 4),                       -- normalized 0..1 (cosine semantic similarity)
  status text not null default 'suggested'
    check (status in ('suggested', 'confirmed', 'rejected', 'auto_mapped', 'new_created', 'unmatched', 'ignored')),
  matched_by text not null default 'system'
    check (matched_by in ('system', 'user', 'auto_create', 'auto_map')),
  raw jsonb,                                       -- suggestedProductId, ranking debug, etc.
  last_event_key text,                             -- webhook-retry dedup
  last_matched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marketplace_connection_id, external_product_id)
);

create index if not exists product_mappings_tenant_status_idx on product_mappings (tenant_id, status, updated_at desc);
create index if not exists product_mappings_internal_idx on product_mappings (internal_product_id);

drop trigger if exists product_mappings_set_updated_at on product_mappings;
create trigger product_mappings_set_updated_at
  before update on product_mappings
  for each row execute function set_updated_at();
