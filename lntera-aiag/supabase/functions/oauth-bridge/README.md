# oauth-bridge (Supabase Edge Function)

HTTPS callback bridge for Shopee/TikTok OAuth.  
It receives provider callbacks on Supabase and redirects to local Mastra callbacks on `http://localhost:4111`, preserving all query parameters.

## Route shape

- `https://<project-ref>.functions.supabase.co/oauth-bridge/shopee/callback`
- `https://<project-ref>.functions.supabase.co/oauth-bridge/tiktok/callback`

All query params are forwarded unchanged (for example: `code`, `shop_id`, `state`, etc).

## Deploy

From project root:

```bash
supabase functions deploy oauth-bridge --project-ref <project-ref>
```

Example:

```bash
supabase functions deploy oauth-bridge --project-ref ptcronhzstmrmclohodt
```

## Partner dashboard callback configuration

Use these HTTPS URLs in each platform console:

- Shopee callback URL: `https://<project-ref>.functions.supabase.co/oauth-bridge/shopee/callback`
- TikTok callback URL: `https://<project-ref>.functions.supabase.co/oauth-bridge/tiktok/callback`

## Local requirements

- Local Mastra server is running on `http://localhost:4111`.
- Local callbacks exist:
  - `http://localhost:4111/oauth/shopee/callback`
  - `http://localhost:4111/oauth/tiktok/callback`

If local server is not running, the bridge still redirects but browser will fail to connect to localhost.
