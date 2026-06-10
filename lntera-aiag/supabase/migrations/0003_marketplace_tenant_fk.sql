-- Backfill and enforce tenant foreign-key on marketplace_connections.

-- 1) Ensure a default tenant exists for legacy rows without tenant_id.
insert into tenant_master (slug, name)
values ('default', 'Default Tenant')
on conflict (slug) do nothing;

-- 2) Create tenant records for existing non-UUID legacy tenant_id values.
insert into tenant_master (slug, name)
select distinct
  mc.tenant_id as slug,
  initcap(replace(mc.tenant_id, '-', ' ')) as name
from marketplace_connections mc
where mc.tenant_id is not null
  and mc.tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
on conflict (slug) do nothing;

-- 3) Create tenant records for existing UUID tenant_id values if missing.
insert into tenant_master (id, slug, name)
select distinct
  mc.tenant_id::uuid as id,
  'tenant-' || left(replace(mc.tenant_id, '-', ''), 12) as slug,
  'Tenant ' || left(mc.tenant_id, 8) as name
from marketplace_connections mc
left join tenant_master tm on tm.id = mc.tenant_id::uuid
where mc.tenant_id is not null
  and mc.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and tm.id is null
on conflict (id) do nothing;

-- 4) Add transitional UUID column.
alter table marketplace_connections
  add column if not exists tenant_id_uuid uuid;

-- 5) Backfill UUID tenant refs.
update marketplace_connections mc
set tenant_id_uuid = mc.tenant_id::uuid
where mc.tenant_id is not null
  and mc.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

update marketplace_connections mc
set tenant_id_uuid = tm.id
from tenant_master tm
where mc.tenant_id is not null
  and mc.tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and tm.slug = mc.tenant_id;

update marketplace_connections mc
set tenant_id_uuid = tm.id
from tenant_master tm
where mc.tenant_id is null
  and tm.slug = 'default';

-- 6) Enforce new UUID tenant FK shape.
alter table marketplace_connections
  drop constraint if exists marketplace_connections_tenant_id_fkey;

drop index if exists marketplace_connections_tenant_idx;

alter table marketplace_connections
  drop column tenant_id;

alter table marketplace_connections
  rename column tenant_id_uuid to tenant_id;

alter table marketplace_connections
  alter column tenant_id set not null;

alter table marketplace_connections
  add constraint marketplace_connections_tenant_id_fkey
  foreign key (tenant_id) references tenant_master(id) on update cascade on delete restrict;

create index if not exists marketplace_connections_tenant_idx
  on marketplace_connections (tenant_id);
