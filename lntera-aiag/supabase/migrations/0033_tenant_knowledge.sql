-- Tenant knowledge base / GraphRAG: source-of-truth documents + quota tracking.
-- The actual graph (chunks/entities/relationships) lives in FalkorDB, one named graph per tenant
-- ("tenant:{tenant_id}"); these tables are what survives a GRAPH.DELETE (inactivity eviction) so the
-- graph can be rebuilt from source rather than restored from an unreliable FalkorDB snapshot.

create table public.tenant_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant_master(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  byte_size integer not null check (byte_size >= 0),
  storage_path text not null,
  source_type text not null default 'document' check (source_type in ('document', 'chat')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tenant_knowledge_documents_tenant_id_idx on public.tenant_knowledge_documents (tenant_id);
create index tenant_knowledge_documents_tenant_status_idx on public.tenant_knowledge_documents (tenant_id, status);

alter table public.tenant_knowledge_documents enable row level security;

create trigger set_updated_at
  before update on public.tenant_knowledge_documents
  for each row execute function public.set_updated_at();

-- One row per tenant: running byte total against the 10MB cap, plus FalkorDB graph lifecycle state.
create table public.tenant_knowledge_usage (
  tenant_id uuid primary key references public.tenant_master(id) on delete cascade,
  bytes_used bigint not null default 0 check (bytes_used >= 0),
  byte_limit bigint not null default 10485760,
  graph_evicted_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_knowledge_usage enable row level security;

create trigger set_updated_at
  before update on public.tenant_knowledge_usage
  for each row execute function public.set_updated_at();

-- Private bucket for original uploaded files (PDFs/spreadsheets/etc.) — accessed only via the
-- service-role backend, never directly from the client, so no public storage policies are needed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('tenant-knowledge-docs', 'tenant-knowledge-docs', false, 10485760)
on conflict (id) do nothing;
