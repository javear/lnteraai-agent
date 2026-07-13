-- Research reports: agent-generated comprehensive analysis/prediction documents (internal GraphRAG +
-- external web search synthesized into sections/charts/images/citations), persisted for later viewing
-- and optional public sharing. Same deny-all/service-role-only RLS convention as every other tenant
-- table — the app talks to Supabase via the service role, tenant scoping is enforced in application code.

create table public.tenant_research_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant_master(id) on delete cascade,
  topic text not null,
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  content jsonb,               -- { sections, charts, images, citations } once ready
  error_message text,
  is_public boolean not null default false,
  public_slug text unique,     -- unguessable random slug; regenerating revokes the old link
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tenant_research_reports_tenant_idx on public.tenant_research_reports (tenant_id, created_at desc);

alter table public.tenant_research_reports enable row level security;

create trigger set_updated_at
  before update on public.tenant_research_reports
  for each row execute function public.set_updated_at();
