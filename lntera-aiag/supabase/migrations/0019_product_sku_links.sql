-- Per-SKU cross-store link for bidirectional attribute sync. product_mappings is product-level, but
-- stock/price live per SKU, so this row joins one INTERNAL sku to its EXTERNAL sku within a mapping.
-- It also carries (a) last_seen_external_stock — the baseline for computing "qty sold" deltas — and
-- (b) last_pushed_external_stock/price + last_push_at — the echo write-marker, so our own pushes that
-- bounce back as webhooks are recognized and NOT re-propagated.

create table if not exists product_sku_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  mapping_id uuid not null references product_mappings(id) on update cascade on delete cascade,
  internal_sku_id uuid not null references tenant_product_skus(id) on update cascade on delete cascade,
  external_sku_id text,                              -- Shopee model_id / TikTok sku.id (null for single-SKU)
  last_seen_external_stock integer,                  -- delta baseline ("what this store last told us")
  last_pushed_external_stock integer,                -- echo write-marker (value we last pushed)
  last_pushed_price numeric(18, 4),
  last_push_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mapping_id, internal_sku_id)
);

create unique index if not exists product_sku_links_external_uq
  on product_sku_links (mapping_id, external_sku_id) where external_sku_id is not null;
create index if not exists product_sku_links_tenant_idx on product_sku_links (tenant_id);
create index if not exists product_sku_links_mapping_idx on product_sku_links (mapping_id);
create index if not exists product_sku_links_internal_sku_idx on product_sku_links (internal_sku_id);

drop trigger if exists product_sku_links_set_updated_at on product_sku_links;
create trigger product_sku_links_set_updated_at
  before update on product_sku_links
  for each row execute function set_updated_at();
