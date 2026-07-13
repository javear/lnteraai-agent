-- Track which specific auth user requested a research report, so the "report ready" email goes only
-- to them (not every user on the tenant workspace) — chat notifications already reach the whole
-- tenant, but email is more personal/inbox-visible, so it's scoped to the requester alone.
alter table public.tenant_research_reports
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
