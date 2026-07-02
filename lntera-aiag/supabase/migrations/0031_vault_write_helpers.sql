-- Write side of the Vault-reference convention. 0005 added a read helper
-- (resolve_integration_vault_secret); these let the server create/update encrypted secrets and get
-- back a Vault id to store in a *_secret_ref column. Payload is stored as JSON text in Vault.
-- service_role only — mirrors the SECURITY DEFINER + grant pattern in 0005_tenant_integrations.sql.

create extension if not exists supabase_vault cascade;

-- Create a new Vault secret from a JSON payload; returns the new secret id.
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
  new_id uuid;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'vault secret name is required';
  end if;
  if p_payload is null then
    raise exception 'vault secret payload is required';
  end if;

  new_id := vault.create_secret(p_payload::text, p_name, p_description);
  return new_id;
end;
$$;

-- Replace an existing Vault secret's JSON payload (rotate a token without changing its ref).
create or replace function public.update_integration_vault_secret(
  p_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_id is null then
    raise exception 'vault secret id is required';
  end if;
  if p_payload is null then
    raise exception 'vault secret payload is required';
  end if;

  perform vault.update_secret(p_id, p_payload::text);
end;
$$;

revoke all on function public.create_integration_vault_secret(text, jsonb, text) from public;
revoke all on function public.update_integration_vault_secret(uuid, jsonb) from public;
grant execute on function public.create_integration_vault_secret(text, jsonb, text) to service_role;
grant execute on function public.update_integration_vault_secret(uuid, jsonb) to service_role;
