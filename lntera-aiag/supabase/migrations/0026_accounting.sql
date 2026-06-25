-- Phase 3: advanced finance (OPT-IN). Double-entry accounting projected from tenant_transactions.
-- Gated per tenant by tenant_finance_settings.accounting_enabled (default false). Transaction recording
-- (Phase 1) stays always-on regardless.

create table if not exists tenant_finance_settings (
  tenant_id uuid primary key,
  accounting_enabled boolean not null default false,
  base_currency text not null default 'IDR',
  fiscal_year_start_month int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-tenant chart of accounts (seeded with an editable default when accounting is enabled).
create table if not exists chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  name text not null,
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  parent_id uuid references chart_of_accounts(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create index if not exists chart_of_accounts_tenant_idx on chart_of_accounts (tenant_id);

create sequence if not exists journal_entry_no_seq;

-- A balanced double-entry transaction (Σ debit = Σ credit across its lines).
create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  entry_no bigint not null default nextval('journal_entry_no_seq'),
  date date not null default current_date,
  source_transaction_id uuid references tenant_transactions(id) on delete set null,
  description text,
  status text not null default 'posted' check (status in ('draft', 'posted', 'void')),
  currency text not null default 'IDR',
  created_by text not null default 'system',
  created_at timestamptz not null default now()
);
create index if not exists journal_entries_tenant_date_idx on journal_entries (tenant_id, date);
create index if not exists journal_entries_src_txn_idx on journal_entries (source_transaction_id);

create table if not exists journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references journal_entries(id) on delete cascade,
  tenant_id uuid not null,
  account_id uuid not null references chart_of_accounts(id),
  account_code text not null, -- denormalized for export
  debit numeric(18, 4) not null default 0,
  credit numeric(18, 4) not null default 0,
  description text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  check (debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0))
);
create index if not exists journal_lines_entry_idx on journal_lines (entry_id);
create index if not exists journal_lines_account_idx on journal_lines (tenant_id, account_id);

-- Dynamic mapping: per transaction_type, a list of {account, side, amount_source} the posting engine
-- turns into journal lines. Seeded with editable defaults. account_id keeps mappings stable across renames.
create table if not exists posting_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  transaction_type text not null,
  sequence int not null default 0,
  account_id uuid not null references chart_of_accounts(id) on delete cascade,
  side text not null check (side in ('debit', 'credit')),
  amount_source text not null, -- gross | net | fee | tax | shipping | discount
  created_at timestamptz not null default now()
);
create index if not exists posting_rules_tenant_type_idx on posting_rules (tenant_id, transaction_type);
