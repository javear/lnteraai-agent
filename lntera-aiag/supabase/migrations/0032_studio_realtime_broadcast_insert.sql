-- Studio bridge (arch A) needs the BROWSER to broadcast command *results* back on its own tenant
-- topic. Migration 0009 only granted SELECT (receive); broadcasting from a client (`channel.send`)
-- inserts into realtime.messages and needs an INSERT policy. Same scoping: a member may only send on
-- `tenant:<their tenant_id>`. The server keeps using the service key (bypasses RLS) to send commands.

drop policy if exists "tenant members send tenant broadcasts" on realtime.messages;
create policy "tenant members send tenant broadcasts"
  on realtime.messages
  for insert
  to authenticated
  with check (
    extension = 'broadcast'
    and realtime.topic() = 'tenant:' || coalesce(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')
  );
