# Deploying the Mastra backend to Railway (Docker)

The backend ships as a Docker image built by [`Dockerfile.mastra-server`](./Dockerfile.mastra-server).
Railway builds it on every push to `main` (CI/CD). The frontend deploys separately on Vercel
(`web/VERCEL.md`); the two run on different origins and talk cross-origin (Bearer-token auth).

## How the image works

- **Build stage**: `npm ci` (the `mastra` CLI is a devDependency) → `npm run build` (= `mastra build`).
  Mastra bundles the Hono server and runs `npm install` inside `.mastra/output`, producing a
  self-contained output directory.
- **Runtime stage**: copies the whole `.mastra/output` (incl. its own `node_modules`) and runs
  `node index.mjs`. `MASTRA_HOST=0.0.0.0` is baked in so the container is reachable; the server listens
  on Railway's injected `PORT` (default 4111). `DATABASE_URL` is only needed at **runtime**, not build.

## Railway service setup

1. **New Project → Deploy from GitHub repo** → pick this repo, branch `main`.
2. In the service **Settings**:
   - **Root Directory** = `lntera-aiag` (so the build context is the backend package).
   - Railway auto-detects [`railway.json`](./railway.json) → builds with `Dockerfile.mastra-server`
     and health-checks `/svc/v1/public-config`. (No build/start command needed — the Dockerfile owns it.)
3. Add the environment variables below → Deploy. Railway assigns a public domain (and `PORT`).

## Environment variables (set in the Railway dashboard)

Required:

- `DATABASE_URL` — Supabase **session pooler (port 5432)**, *not* the transaction pooler (6543).
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role), `SUPABASE_PUBLISHABLE_KEY` (anon).
- `PORTKEY_API_KEY` (+ `PORTKEY_ADMIN_API_KEY` to provision tenant LLM keys).
- `OPENAPI_JWT_SECRET`, `OPENAPI_SERVICE_API_KEY`, `OAUTH_STATE_SECRET`.
- `NODE_ENV=production` (enables auth). Do **not** set `MASTRA_DEV`.
- `MASTRA_PUBLIC_BASE_URL` = this Railway service's public URL (OAuth callbacks + push deep-links).
- `MASTRA_CORS_ORIGINS` and `WEB_APP_ORIGIN` = your Vercel app URL.

Optional (per feature): `OPENAI_API_KEY`, `ONESIGNAL_*`, marketplace OAuth (`SHOPEE_*`, `TIKTOK_*`,
`DISCORD_*`), token-efficiency / regex-guard knobs. See `.env.example` for the full grouped list.

> **Discord embedded:** unlike serverless, Railway is a persistent container, so running the Discord
> Gateway in-process is viable — set `DISCORD_EMBEDDED=1` if you want it (with `DISCORD_BOT_TOKEN`).
> Leave it unset to run the bot separately (`npm run discord`).

## Cross-wiring with Vercel (first deploy)

There's a one-time chicken-and-egg between the two URLs:

1. Deploy **Railway** first → note its public URL `https://<svc>.up.railway.app`.
2. On **Vercel**, set `VITE_API_BASE_URL` = that Railway URL and redeploy.
3. Back on **Railway**, set `MASTRA_CORS_ORIGINS` + `WEB_APP_ORIGIN` = your Vercel URL and redeploy.
4. Add the Vercel origin to the Supabase (auth redirect) and OneSignal (web-push) dashboards.

## CI/CD (push to `main` → both deploy)

- Railway watches `main`, Root Directory `lntera-aiag`; Vercel watches `main`, Root Directory
  `lntera-aiag/web`. Each builds only its own subtree — no cross-contamination.
- Optional, to skip no-op rebuilds: set Railway **Watch Paths** to ignore `web/**`, and a Vercel
  **Ignored Build Step** that skips when only the backend changed. Not required for correctness.

## Local sanity check

```bash
docker build -f lntera-aiag/Dockerfile.mastra-server -t mastra-server lntera-aiag
docker run --rm -e DATABASE_URL='postgresql://…:5432/postgres?sslmode=require' \
  -e PORT=8080 -p 8080:8080 mastra-server
curl -s http://localhost:8080/svc/v1/public-config   # → 200 JSON
```

(The server needs a reachable `DATABASE_URL` to boot — storage init throws otherwise, by design.)
