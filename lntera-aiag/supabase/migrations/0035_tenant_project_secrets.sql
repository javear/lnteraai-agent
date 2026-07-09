-- Per-project secrets for Forge (technical-agent) projects: arbitrary tenant-supplied credentials
-- (third-party API keys, webhook secrets, etc.), one row per named secret. Unlike tenant_projects'
-- two fixed *_secret_ref columns (gitea/mcp, both platform-internal), these are named by the tenant
-- or the agent (e.g. SHOPEE_API_KEY) and injected into the project's dev sandbox and deployed EdgeOne
-- function at runtime. secret_ref follows the same Vault-reference convention as tenant_projects —
-- plaintext NEVER stored here, only a pointer into Supabase Vault.

create table public.tenant_project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.tenant_projects(id) on delete cascade,
  name text not null,          -- env var name, e.g. SHOPEE_API_KEY — validated app-side, not here
  description text,            -- what it's for, shown in the UI list (never the value)
  secret_ref jsonb not null,   -- Vault reference ({ "type": "id"|"name", "value": "<secret>" })
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, name)
);

create index tenant_project_secrets_project_id_idx on public.tenant_project_secrets (project_id);

alter table public.tenant_project_secrets enable row level security;

create trigger set_updated_at
  before update on public.tenant_project_secrets
  for each row execute function public.set_updated_at();
