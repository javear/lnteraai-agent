-- Internal tenant product catalog. A product originates either on our platform ('internal')
-- or is synced from a marketplace ('marketplace'). Short, high-signal fields (title/brand/uom/
-- variant names) are embedded for hybrid (full-text + vector) similarity matching; description
-- and images are stored but NEVER embedded (token cost). Dynamic attributes/raw are JSONB so the
-- model covers both Shopee + TikTok and future marketplaces.

create table if not exists tenant_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,

  -- provenance
  source_origin text not null default 'internal' check (source_origin in ('internal', 'marketplace')),
  source_platform text,
  source_connection_id uuid references marketplace_connections(id) on update cascade on delete set null,

  -- matchable core (short, high-signal — embedded)
  title text not null,
  brand text,
  uom text,
  status text not null default 'active' check (status in ('active', 'inactive', 'draft', 'archived', 'unknown')),
  currency text,

  -- flexible / future-proof (stored, NOT embedded)
  description text,
  category_id text,
  brand_id text,
  image_urls jsonb,
  attributes jsonb not null default '[]'::jsonb,
  dimensions jsonb,
  weight_grams integer,
  raw jsonb,

  -- embedding + search
  embedding_source_text text,
  embedding vector(1024),
  embedding_model text,
  embedding_version integer,
  embedded_at timestamptz,
  content_tsv tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(
        embedding_source_text,
        coalesce(title, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(uom, '')
      )
    )
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_products_tenant_idx on tenant_products (tenant_id, status);
create index if not exists tenant_products_origin_idx on tenant_products (tenant_id, source_origin, source_platform);
create index if not exists tenant_products_tsv_idx on tenant_products using gin (content_tsv);
create index if not exists tenant_products_attributes_gin on tenant_products using gin (attributes jsonb_path_ops);
create index if not exists tenant_products_title_trgm on tenant_products using gin (title gin_trgm_ops);
create index if not exists tenant_products_embedding_hnsw
  on tenant_products using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;

drop trigger if exists tenant_products_set_updated_at on tenant_products;
create trigger tenant_products_set_updated_at
  before update on tenant_products
  for each row execute function set_updated_at();
