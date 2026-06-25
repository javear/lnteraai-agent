-- Per-tenant one-shot "future action" for the Active Agent. The seller tells the agent to do
-- something later ("send me a tax recap by 10am tomorrow", "check my TikTok orders at 4pm"); the agent
-- stores the instruction + the absolute fire time here, an Inngest delayed event runs the FULL general
-- agent with that prompt at the time, and the result is posted into the tenant's Notifications chat.
--
-- Free tier: exactly ONE active (status='scheduled') task per tenant (the unique index below). A new
-- request while one is pending COMBINES into the same row (the tool appends the instruction); after a
-- task runs (status done/error/canceled) the single row is reused for the next request.
-- Premium (later) can relax this to multiple labeled tasks.

create table if not exists tenant_scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  -- The natural-language instruction the agent will execute at run time (may be combined from several
  -- requests at the same fire time).
  prompt text not null,
  -- Absolute instant the task fires (UTC). Resolved from the user's phrasing in `timezone`.
  run_at timestamptz not null,
  -- IANA timezone the run time was interpreted in (for display/recompute); falls back to tenant_master.
  timezone text,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'error', 'canceled')),
  -- The delivered agent answer / error detail of the last run (audit + UI).
  last_result text,
  last_error text,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per tenant (free tier): the single row is reused across requests (combine while pending,
-- overwrite once it has run).
create unique index if not exists tenant_scheduled_tasks_tenant_uq
  on tenant_scheduled_tasks (tenant_id);

-- The recovery sweep scans pending tasks to (re)arm them.
create index if not exists tenant_scheduled_tasks_scheduled_idx
  on tenant_scheduled_tasks (run_at) where status = 'scheduled';

drop trigger if exists tenant_scheduled_tasks_set_updated_at on tenant_scheduled_tasks;
create trigger tenant_scheduled_tasks_set_updated_at
  before update on tenant_scheduled_tasks
  for each row execute function set_updated_at();
