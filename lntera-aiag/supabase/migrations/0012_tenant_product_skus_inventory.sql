-- Variants/SKUs + multi-warehouse inventory for the internal catalog. Normalized (not a JSONB blob)
-- because inventory mutates frequently (stock webhooks): a normalized (sku, warehouse) row updates
-- in place with no read-modify-write race. Per-SKU sales attributes (Color/Size) stay JSONB.

create table if not exists tenant_product_skus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  product_id uuid not null references tenant_products(id) on update cascade on delete cascade,
  seller_sku text,
  label text,
  attributes jsonb not null default '[]'::jsonb,   -- [{ name, value }]
  price numeric(18, 4),
  currency text,
  image_url text,
  external_sku_id text,                            -- Shopee model_id / TikTok sku.id
  position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_product_skus_product_idx on tenant_product_skus (product_id);
create index if not exists tenant_product_skus_tenant_idx on tenant_product_skus (tenant_id);
create unique index if not exists tenant_product_skus_seller_sku_uq
  on tenant_product_skus (tenant_id, product_id, seller_sku) where seller_sku is not null;

drop trigger if exists tenant_product_skus_set_updated_at on tenant_product_skus;
create trigger tenant_product_skus_set_updated_at
  before update on tenant_product_skus
  for each row execute function set_updated_at();

create table if not exists tenant_warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  name text,
  platform text,                                   -- null = internal; 'shopee' | 'tiktok'
  external_warehouse_id text,                      -- TikTok warehouse_id / Shopee location_id
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform, external_warehouse_id)
);

create index if not exists tenant_warehouses_tenant_idx on tenant_warehouses (tenant_id);

drop trigger if exists tenant_warehouses_set_updated_at on tenant_warehouses;
create trigger tenant_warehouses_set_updated_at
  before update on tenant_warehouses
  for each row execute function set_updated_at();

create table if not exists tenant_inventory (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  sku_id uuid not null references tenant_product_skus(id) on update cascade on delete cascade,
  warehouse_id uuid references tenant_warehouses(id) on update cascade on delete set null,
  quantity integer not null default 0,
  reserved integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (sku_id, warehouse_id)
);

create index if not exists tenant_inventory_tenant_idx on tenant_inventory (tenant_id);
create index if not exists tenant_inventory_sku_idx on tenant_inventory (sku_id);

drop trigger if exists tenant_inventory_set_updated_at on tenant_inventory;
create trigger tenant_inventory_set_updated_at
  before update on tenant_inventory
  for each row execute function set_updated_at();
