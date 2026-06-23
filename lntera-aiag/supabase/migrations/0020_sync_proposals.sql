-- Pending NOTIFY proposals. When autopilot is OFF, a computed propagation waits here for the user to
-- approve (Yes / Always) or Dismiss from the Active Agent notification. `payload` holds the fully
-- computed per-store/per-SKU targets so applying is deterministic — but the handler RE-VALIDATES
-- against current internal truth before pushing, so a stale snapshot is never blindly applied.

create table if not exists sync_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  master_product_id uuid not null references tenant_products(id) on update cascade on delete cascade,
  attribute text not null check (attribute in ('stock', 'price')),
  source_connection_id uuid references marketplace_connections(id) on update cascade on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists sync_proposals_tenant_status_idx on sync_proposals (tenant_id, status, created_at desc);

drop trigger if exists sync_proposals_set_updated_at on sync_proposals;
create trigger sync_proposals_set_updated_at
  before update on sync_proposals
  for each row execute function set_updated_at();
