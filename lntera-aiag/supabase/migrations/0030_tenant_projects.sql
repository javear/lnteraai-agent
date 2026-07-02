-- Technical-agent ("Studio") projects: one row per tenant coding project (MCP server or web app).
-- Source of truth for a project's code is its Gitea repo; this table holds correlation + deploy state.
-- Secrets (Gitea/MCP tokens) live in Supabase Vault — the *_secret_ref columns only point at them,
-- following the same Vault-reference convention as tenant_integrations / Discord.

create table if not exists tenant_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,

  name text not null,
  kind text not null check (kind in ('mcp', 'webapp')),

  -- Non-secret metadata.
  gitea_repo text,   -- clone URL, e.g. https://gitea.com/<org>/<repo>.git
  deploy_url text,   -- EdgeOne subdomain, e.g. https://<project>.edgeone.app
  mcp_url text,      -- deployed MCP endpoint (kind = 'mcp')

  -- Vault references ({ "type": "id"|"name", "value": "<secret>" }); NEVER plaintext tokens.
  gitea_secret_ref jsonb,  -- decrypts to { token, username }
  mcp_secret_ref jsonb,    -- decrypts to { authToken }

  status text not null default 'draft' check (status in ('draft', 'deployed', 'connected', 'error')),
  config jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, name)
);

create index if not exists tenant_projects_tenant_idx on tenant_projects (tenant_id, status);
create index if not exists tenant_projects_kind_idx on tenant_projects (tenant_id, kind);

drop trigger if exists tenant_projects_set_updated_at on tenant_projects;
create trigger tenant_projects_set_updated_at
  before update on tenant_projects
  for each row execute function set_updated_at();
