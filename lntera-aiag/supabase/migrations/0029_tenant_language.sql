-- Per-tenant UI + assistant language preference. Drives (1) the agent's reply language, (2) the app's
-- UI labels, and (3) the language of server-initiated messages (notifications, scheduled tasks). Stored
-- on tenant_master alongside `timezone`. No CHECK constraint on the value on purpose: supported languages
-- are validated by the app's locale registry, so adding a new language is a frontend/locale change — not
-- a schema migration.
alter table tenant_master add column if not exists language text not null default 'en';
