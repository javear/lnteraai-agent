-- Realtime Authorization for per-tenant notification broadcasts.
--
-- The server broadcasts notifications to the private topic `tenant:<tenantId>` via the Realtime
-- REST endpoint using the service key (which bypasses RLS). This policy governs which AUTHENTICATED
-- clients may *receive* (subscribe to) a given topic: only users whose JWT app_metadata.tenant_id
-- matches the topic's tenant. Clients subscribe with `{ config: { private: true } }` after calling
-- `supabase.realtime.setAuth(accessToken)`.
--
-- Apply in Supabase (SQL editor or `supabase db push`). Modifying the `realtime` schema requires
-- the postgres/service role.

alter table realtime.messages enable row level security;

drop policy if exists "tenant members receive tenant broadcasts" on realtime.messages;
create policy "tenant members receive tenant broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'tenant:' || coalesce(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')
  );
