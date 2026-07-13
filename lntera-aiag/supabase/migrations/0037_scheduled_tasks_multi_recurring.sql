-- Raise the Active Agent's scheduled-future-task limit from 1 (singleton row per tenant) to up to 10,
-- and support recurring schedules ("every morning at 8am") alongside today's one-shot tasks. The
-- 10-active-per-tenant cap is enforced in application code (scheduled-task-prefs.ts) before insert —
-- not expressible as a clean unique index once more than one row per tenant is allowed.

-- Drop the singleton constraint — multiple active rows per tenant are now allowed.
drop index if exists tenant_scheduled_tasks_tenant_uq;

alter table tenant_scheduled_tasks
  add column if not exists kind text not null default 'once' check (kind in ('once', 'recurring')),
  -- Recurring-only fields, same shape as tenant_insight_schedules' battle-tested recurrence model
  -- (reused via nextRunFor() rather than forking the date math): local clock time ('HH:MM') + ISO
  -- weekdays (0=Sunday..6=Saturday) + the precomputed next occurrence. NULL for kind='once', which
  -- keeps using run_at exactly as before.
  add column if not exists local_time text,
  add column if not exists days_of_week int[],
  add column if not exists next_run_at timestamptz;

create index if not exists tenant_scheduled_tasks_next_run_idx
  on tenant_scheduled_tasks (next_run_at) where status = 'scheduled' and kind = 'recurring';
