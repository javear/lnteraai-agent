-- Tenant users (maps Supabase auth.users -> tenant_master) and per-tenant role definitions.
-- Auth is handled by Supabase; this layer maps an authenticated user to a tenant + role,
-- and a role to the set of agent tools it may use. Service-role only (RLS deny-by-default);
-- the server reads/writes with the service key, clients never touch these tables directly.

-- Per-tenant role definitions. allowed_tools holds Mastra tool .id values; {'*'} means all tools.
create table if not exists tenant_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  slug text not null,
  name text not null,
  allowed_tools text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists tenant_roles_tenant_idx on tenant_roles (tenant_id);

drop trigger if exists tenant_roles_set_updated_at on tenant_roles;
create trigger tenant_roles_set_updated_at
  before update on tenant_roles
  for each row execute function set_updated_at();

-- A user's membership of a tenant, with the role slug that governs their tool access.
create table if not exists tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  auth_user_id uuid not null references auth.users(id) on update cascade on delete cascade,
  email text,
  role text not null default 'member',
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id)
);

create index if not exists tenant_users_auth_user_idx on tenant_users (auth_user_id);
create index if not exists tenant_users_tenant_idx on tenant_users (tenant_id);

drop trigger if exists tenant_users_set_updated_at on tenant_users;
create trigger tenant_users_set_updated_at
  before update on tenant_users
  for each row execute function set_updated_at();

-- RLS on, no policies: only the service role (our server) can access. Clients use
-- supabase-js for authentication only, never for direct table access.
alter table tenant_roles enable row level security;
alter table tenant_users enable row level security;
