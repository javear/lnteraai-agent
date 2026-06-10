-- Tenant Groq + Portkey linkage uses tenant_integrations (integration_code = 'groq').
-- No schema change: config JSON holds Portkey slugs/IDs only (never the Groq API key).

comment on table tenant_integrations is
  'Per-tenant integration config. integration_code groq stores Portkey Model Catalog slugs for tenant-scoped Groq keys.';
