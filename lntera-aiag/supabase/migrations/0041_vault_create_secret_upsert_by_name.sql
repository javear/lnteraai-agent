-- create_integration_vault_secret is called every time a caller wants a fresh Vault-backed secret
-- (e.g. Studio's MCP "Connect" route builds a deterministic name from the project id). If a PRIOR
-- attempt created the secret but the caller's own follow-up write (persisting the returned ref) then
-- failed for any reason, the row is left ORPHANED in vault.secrets with no `*_secret_ref` pointing at
-- it — confirmed in production: a project's `mcp_secret_ref` was null and `status` stuck at
-- 'deployed', while vault.secrets already had a row named `studio:mcp:<project id>`. Every retry of
-- "Connect" then failed identically with "duplicate key value violates unique constraint
-- secrets_name_idx", with no way to recover short of manually deleting the orphaned row.
--
-- Make this idempotent by NAME: if a secret with this name already exists, update its payload in
-- place and return the EXISTING id instead of raising. This also naturally covers legitimate
-- re-connect-after-disconnect flows that reuse the same deterministic name.
create or replace function public.create_integration_vault_secret(
  p_name text,
  p_payload jsonb,
  p_description text default 'tenant integration secret'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'vault secret name is required';
  end if;
  if p_payload is null then
    raise exception 'vault secret payload is required';
  end if;

  select id into existing_id from vault.secrets where name = p_name;
  if existing_id is not null then
    perform vault.update_secret(existing_id, p_payload::text);
    return existing_id;
  end if;

  new_id := vault.create_secret(p_payload::text, p_name, p_description);
  return new_id;
end;
$$;
