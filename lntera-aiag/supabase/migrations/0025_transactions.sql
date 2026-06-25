-- Canonical transaction store (Phase 1 of the transaction-sync + ledger plan).
-- Always-on: every tenant records transactions here regardless of the advanced-finance toggle.
-- External transactions are idempotent per (tenant, source, external_id) so webhooks/API never double-record.

create table if not exists tenant_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  source text not null check (source in ('marketplace', 'internal', 'manual')),
  marketplace_connection_id uuid references marketplace_connections(id) on delete set null,
  platform text,
  external_id text,
  -- dynamic (text, not enum): sale | refund | fee | payout | service | expense | ...
  type text not null,
  status text not null default 'completed',
  currency text not null default 'IDR',
  gross_amount numeric(18, 4) not null default 0,
  fee_amount numeric(18, 4) not null default 0,
  tax_amount numeric(18, 4) not null default 0,
  net_amount numeric(18, 4) not null default 0,
  occurred_at timestamptz not null default now(),
  counterparty jsonb, -- { name, npwp, ... }
  description text,
  raw_payload jsonb, -- original webhook/API body (audit)
  metadata jsonb,
  posted boolean not null default false, -- whether projected into a journal entry (Phase 3)
  journal_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency: an external transaction is recorded at most once per (tenant, source, external_id).
create unique index if not exists tenant_transactions_external_uq
  on tenant_transactions (tenant_id, source, external_id)
  where external_id is not null;

create index if not exists tenant_transactions_tenant_time_idx
  on tenant_transactions (tenant_id, occurred_at desc);
create index if not exists tenant_transactions_posting_idx
  on tenant_transactions (tenant_id, posted);

create table if not exists tenant_transaction_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references tenant_transactions(id) on delete cascade,
  tenant_id uuid not null,
  -- dynamic kinds cover products AND services AND fees/tax/shipping/discount.
  line_kind text not null check (line_kind in ('product', 'service', 'fee', 'tax', 'shipping', 'discount', 'adjustment')),
  item_ref_type text, -- 'product_sku' | 'service' | null
  item_ref_id uuid, -- e.g. tenant_product_skus.id for products
  external_line_id text,
  description text,
  quantity numeric(18, 4),
  unit_price numeric(18, 4),
  amount numeric(18, 4) not null default 0,
  tax_amount numeric(18, 4) not null default 0,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tenant_transaction_lines_txn_idx
  on tenant_transaction_lines (transaction_id);
