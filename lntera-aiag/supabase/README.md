# Supabase setup

This folder holds the SQL schema used by the Mastra app for marketplace OAuth.

## One-time provisioning

1. Create a Supabase project (https://supabase.com).
2. In the Supabase dashboard, open **SQL Editor** and run the contents of
   [`migrations/0001_marketplace_connections.sql`](./migrations/0001_marketplace_connections.sql).
   Alternatively, with the Supabase CLI installed:

   ```bash
   supabase db push
   ```

3. Copy `.env.example` to `.env` and fill in:

   - `SUPABASE_URL` - found under **Project Settings -> API -> Project URL**
   - `SUPABASE_SECRET_KEY` (recommended) - found under
     **Project Settings -> API Keys -> Secret keys**. Format: `sb_secret_...`.
     These are the new-style keys (rotatable, multiple per project). Either
     this **or** the legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted; the helper
     prefers `SUPABASE_SECRET_KEY` if both are present.

   Both keys bypass Row Level Security and are required because the app
   writes/refreshes tokens server-side. **Never expose either to a browser client.**

## Schema overview

`marketplace_connections` is keyed by `(platform, external_shop_id)`. One row represents
one authorized shop on one marketplace. Tokens are auto-refreshed by the integration
helpers when they are within ~5 minutes of expiry.

`tenant_integrations` (see [`migrations/0005_tenant_integrations.sql`](./migrations/0005_tenant_integrations.sql))
stores per-tenant integration metadata as JSON (`config`).

**Discord (recommended):** one platform Discord application. Set the bot token in the Mastra
process environment as `DISCORD_BOT_TOKEN` (not in the database). Each tenant row
(`integration_code = discord`) holds **linkage and consent only**: `guildId`, `channelId`,
`dataProcessingAcknowledgedAt`, optional `termsAcknowledgedVersion`, and `enabled`. Plaintext
bot tokens must not appear in `tenant_integrations.config`.

Tenants can link Discord via **`GET /oauth/discord/start?tenantId=&lt;slug-or-uuid&gt;`** (tenant must
already exist in `tenant_master`): after OAuth, the callback writes the same `config` JSON into
`tenant_integrations`. Set **`DISCORD_CLIENT_ID`**, **`DISCORD_CLIENT_SECRET`**, **`DISCORD_REDIRECT_URI`**,
and **`OAUTH_STATE_SECRET`** (for signed `state`) in the Mastra process environment; whitelist the
redirect URI in the Discord application.

**Discord (legacy):** if `DISCORD_BOT_TOKEN` is unset, the worker runs in multi-client mode: each
tenant row may reference a **different** bot token in **Supabase Vault** as JSON (`{"token":"..."}`)
via `vaultSecretRef`; the worker resolves secrets with RPC `resolve_integration_vault_secret`
(service role only).
