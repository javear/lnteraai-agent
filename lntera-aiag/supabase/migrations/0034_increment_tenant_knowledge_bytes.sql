-- Atomic byte-counter update for tenant_knowledge_usage — avoids a read-modify-write race when
-- multiple documents for the same tenant finish ingestion concurrently. Never below 0.

create or replace function increment_tenant_knowledge_bytes(p_tenant_id uuid, p_delta bigint)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  new_bytes bigint;
begin
  update tenant_knowledge_usage
     set bytes_used = greatest(0, bytes_used + p_delta),
         last_activity_at = now()
   where tenant_id = p_tenant_id
  returning bytes_used into new_bytes;
  return new_bytes;
end;
$$;
