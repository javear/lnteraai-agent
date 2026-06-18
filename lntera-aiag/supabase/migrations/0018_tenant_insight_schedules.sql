-- Per-tenant scheduled business-analysis ("automatic insights"). At the chosen local time on the
-- chosen weekdays, the Active Agent runs the subscribed insight providers and posts the analysis
-- (with charts) into the tenant's Notifications chat.
--
-- Free tier: exactly ONE schedule per tenant (the unique index below). Premium (later) can relax it
-- to allow multiple labeled schedules — drop tenant_insight_schedules_tenant_uq, add label/is_default,
-- and key uniqueness on (tenant_id, label).

create table if not exists tenant_insight_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  enabled boolean not null default true,
  -- Local clock time snapped to a quarter hour ('HH:MM'), interpreted in `timezone`.
  local_time text not null default '09:00',
  -- ISO weekdays the run is allowed on: 0 = Sunday … 6 = Saturday.
  days_of_week int[] not null default '{1,2,3,4,5}',
  -- IANA timezone (e.g. 'Asia/Jakarta'); falls back to tenant_master.timezone then a constant.
  timezone text,
  -- Subscribed insight provider keys; NULL = all available (default-on) providers.
  subscribed_keys jsonb,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One schedule per tenant (free tier).
create unique index if not exists tenant_insight_schedules_tenant_uq
  on tenant_insight_schedules (tenant_id);

-- The dispatcher scans enabled schedules every 15 min.
create index if not exists tenant_insight_schedules_enabled_idx
  on tenant_insight_schedules (enabled) where enabled;

drop trigger if exists tenant_insight_schedules_set_updated_at on tenant_insight_schedules;
create trigger tenant_insight_schedules_set_updated_at
  before update on tenant_insight_schedules
  for each row execute function set_updated_at();
