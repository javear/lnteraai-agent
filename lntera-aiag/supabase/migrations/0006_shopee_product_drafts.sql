-- Local Shopee product drafts. TikTok has native drafts (save_draft + partial_edit),
-- so this table only backs the Shopee side of the agent's draft tools.
--
-- A draft is the agent's in-progress representation of a product before it is
-- published to Shopee via /product/add_item (+ /product/add_model). Once
-- published we keep the row with status='published' for traceability.

create table if not exists shopee_product_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  marketplace_connection_id uuid references marketplace_connections(id) on update cascade on delete set null,
  external_shop_id text not null,
  status text not null default 'open' check (status in ('open', 'published', 'discarded')),
  data jsonb not null default '{}'::jsonb,
  -- Set on successful publish so the seller can jump from draft to live item.
  published_item_id text,
  last_publish_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shopee_product_drafts_tenant_status_idx
  on shopee_product_drafts (tenant_id, status, updated_at desc);

create index if not exists shopee_product_drafts_shop_status_idx
  on shopee_product_drafts (external_shop_id, status, updated_at desc);

drop trigger if exists shopee_product_drafts_set_updated_at on shopee_product_drafts;
create trigger shopee_product_drafts_set_updated_at
  before update on shopee_product_drafts
  for each row execute function set_updated_at();
