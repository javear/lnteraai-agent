-- Tenant-scoped integration configuration (non-secret metadata + Vault references).
-- Requires Supabase Vault (enabled by default on hosted projects; local installs may need the extension).

create extension if not exists supabase_vault cascade;

create table if not exists tenant_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant_master(id) on update cascade on delete cascade,
  integration_code text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, integration_code)
);

create index if not exists tenant_integrations_tenant_idx on tenant_integrations (tenant_id);
create index if not exists tenant_integrations_code_idx on tenant_integrations (integration_code);

drop trigger if exists tenant_integrations_set_updated_at on tenant_integrations;
create trigger tenant_integrations_set_updated_at
  before update on tenant_integrations
  for each row execute function set_updated_at();

-- Resolve an encrypted Vault secret as JSON (service_role only).
-- Plaintext secrets must never live in tenant_integrations.config.
create or replace function public.resolve_integration_vault_secret(
  p_ref_type text,
  p_ref_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  raw text;
  parsed jsonb;
begin
  if p_ref_type is null or btrim(coalesce(p_ref_value, '')) = '' then
    raise exception 'invalid vault reference';
  end if;

  if p_ref_type = 'id' then
    select ds.decrypted_secret into raw
    from vault.decrypted_secrets ds
    where ds.id = p_ref_value::uuid;
  elsif p_ref_type = 'name' then
    select ds.decrypted_secret into raw
    from vault.decrypted_secrets ds
    where ds.name = p_ref_value
    order by ds.updated_at desc
    limit 1;
  else
    raise exception 'invalid ref_type: %', p_ref_type;
  end if;

  if raw is null then
    raise exception 'vault secret not found';
  end if;

  begin
    parsed := raw::jsonb;
  exception
    when others then
      raise exception 'vault secret must be valid JSON';
  end;

  return parsed;
end;
$$;

revoke all on function public.resolve_integration_vault_secret(text, text) from public;
grant execute on function public.resolve_integration_vault_secret(text, text) to service_role;
