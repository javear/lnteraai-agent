-- Forge git hosting moves from Gitea to a GitHub organization (GITEA_* env vars -> GITHUB_TOKEN/
-- GITHUB_ORG). Rename the clone-URL column to be host-agnostic, and drop the Vault-secret-ref column
-- that was declared for a per-tenant-token model but never actually read or written anywhere — the
-- real token has always been a single global server-side env var.
alter table public.tenant_projects rename column gitea_repo to git_repo_url;
alter table public.tenant_projects drop column if exists gitea_secret_ref;
