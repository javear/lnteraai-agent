# lntera-aiag

Welcome to your new [Mastra](https://mastra.ai/) project! We're excited to see what you'll build.

## Getting Started

Start the development server:

```shell
npm run dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview). It provides an interactive UI for building and testing your agents, along with a REST API that exposes your Mastra application as a local service. This lets you start building without worrying about integration right away.

You can start editing files inside the `src/mastra` directory. The development server will automatically reload whenever you make changes.

## Project layout

```
lntera-aiag/            # Mastra backend (this package) — deploys to Mastra Cloud
  src/mastra/           # agents, tools, processors, server routes, integrations
  scripts/              # dev/verify helpers
  web/                  # React + Vite frontend (separate package) — deploys to Vercel
  supabase/             # SQL migrations + Supabase notes
```

The backend and frontend are separate npm packages. In production the **backend runs on Mastra
Cloud** and the **frontend on Vercel** (cross-origin, Bearer-token auth). For local/self-hosted use,
the backend can also build and serve the SPA at `/app` (the "monolith" target).

## Environment

```shell
cp .env.example .env      # backend — fill in the values you need
```

`.env.example` documents every variable grouped by area (Supabase + `DATABASE_URL`, Portkey, OpenAPI
JWT/secret + `OAUTH_STATE_SECRET`, optional marketplace OAuth, OneSignal, CORS/`WEB_APP_ORIGIN`).
`.env` is gitignored — never commit secrets. The frontend has its own `web/.env.example`
(`VITE_API_BASE_URL`, build-time only).

## Frontend (web app)

```shell
npm run dev:web          # Vite dev (watch-build into the backend's /app for the monolith)
```

Build targets (one codebase, `base` switches per target):

| Target | Command | base | Output |
| --- | --- | --- | --- |
| Monolith (served by this backend at `/app`) | `npm run build:web` | `/app/` | `src/mastra/public/app` |
| Vercel (standalone) | `npm --prefix web run build:vercel` | `/` | `web/dist` |
| Native (Capacitor/Electron) | `npm --prefix web run build:native` | `/` | `web/dist` |

See `web/VERCEL.md` (Vercel) and `web/NATIVE.md` (Capacitor/Electron).

## Tenant Groq (Portkey Model Catalog)

The **General Agent** uses each tenant's own Groq API key, provisioned through [Portkey Model Catalog](https://portkey.ai/docs/product/model-catalog). Set `PORTKEY_API_KEY` and `PORTKEY_ADMIN_API_KEY` in `.env`.

1. Create a row in `tenant_master` (see `supabase/README.md`).
2. Open the onboarding page (signed link from Discord, or build manually):
   `GET /integrations/groq/onboard?tenantId=<slug>&token=<signed>`
3. Or use Open API: `PUT /svc/v1/integrations/groq` with a tenant JWT and `{ "groqApiKey": "gsk_..." }`.

Verification scripts:

```shell
npx tsx scripts/verify-portkey-provision.mjs
npx tsx scripts/verify-portkey-model-chain.mjs
npx tsx scripts/verify-groq-rate-limit-chain.mjs
npx tsx scripts/verify-groq-onboard-gate.mjs
npx tsx scripts/verify-groq-reasoning-compat.mjs
npx tsx scripts/verify-token-efficiency.mjs
npx tsx scripts/verify-partial-pii-mask.mjs
npx tsx scripts/verify-regex-filter-config.mjs
```

### Token efficiency

The General Agent limits recalled history (`AGENT_LAST_MESSAGES`, default 8), caps conversation message tokens per step (`AGENT_INPUT_TOKEN_LIMIT`, default 7000 — tool schemas are separate), and on Discord keeps only the last `DISCORD_AMBIENT_RECALL_LIMIT` non-mention channel messages in context (all messages still persist in memory).

**Groq GPT-OSS prompt caching** (`openai/gpt-oss-20b`, `openai/gpt-oss-120b`): Groq automatically caches an identical input prefix across requests (~50% discount on cached input tokens). Keep agent instructions and tool definitions byte-stable; only the suffix (history + user message) should change per turn. Model rolling on 429 fallback may switch models mid-session and cause a one-time cache miss — acceptable. Do not rely on Portkey response cache for multi-turn chat (it dedupes identical full requests, not conversational turns). Check Groq/Portkey usage logs for cached-token fields after deploy.

Verify helpers: `npx tsx scripts/verify-token-efficiency.mjs`. For manual regression: multi-turn order query, product draft flow, and ambient channel messages followed by `@mention` in Discord; compare input token counts in Portkey/Groq logs before and after tuning env knobs.

### Regex guardrails (zero LLM cost)

Optional regex processors on `generalAgent` (`REGEX_FILTER_ENABLED=1`): blocks secrets and prompt-injection patterns in the **latest user message**, applies partial or full PII masking on input and output (default mask char `·` — Discord-markdown safe; e.g. phone `08······7771`, email `a···@···.c··`), and redacts secrets/internal instruction leaks in assistant output. Set `REGEX_PII_MASK_CHAR` to override (avoid `*` in Discord). No extra LLM calls. Off by default. Configure via `REGEX_FILTER_*` in `.env.example`. Verify: `npx tsx scripts/verify-regex-filter-config.mjs` and `npx tsx scripts/verify-partial-pii-mask.mjs`.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). Your bootstrapped project includes example code for [agents](https://mastra.ai/docs/agents/overview), [tools](https://mastra.ai/docs/agents/using-tools), [workflows](https://mastra.ai/docs/workflows/overview), [scorers](https://mastra.ai/docs/evals/overview), and [observability](https://mastra.ai/docs/observability/overview).

If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deployment

Backend → **Railway** (Docker), frontend → **Vercel**. They run on separate origins and talk
cross-origin (Bearer-token auth, no cookies). Pushing to `main` auto-deploys both.

### Backend — Railway (Docker)

The backend ships as a container built by [`Dockerfile.mastra-server`](./Dockerfile.mastra-server).
Create a Railway service from this repo with **Root Directory = `lntera-aiag`**; it auto-detects
[`railway.json`](./railway.json) (Dockerfile build + `/svc/v1/public-config` healthcheck). The image
builds with `mastra build` and runs `node .mastra/output/index.mjs`; `PORT` is injected by Railway and
the container binds `0.0.0.0` (`MASTRA_HOST`). Full runbook + the chicken-and-egg URL wiring:
[`RAILWAY.md`](./RAILWAY.md).

Required env vars (Railway dashboard — see `.env.example` for the full grouped list):

- `DATABASE_URL` — Supabase **session pooler (port 5432)**, *not* the transaction pooler (6543).
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role), `SUPABASE_PUBLISHABLE_KEY` (anon).
- `PORTKEY_API_KEY` (+ `PORTKEY_ADMIN_API_KEY` to provision tenant LLM keys).
- `OPENAPI_JWT_SECRET`, `OPENAPI_SERVICE_API_KEY`, `OAUTH_STATE_SECRET`.
- `NODE_ENV=production` (enables auth; do **not** set `MASTRA_DEV`).
- `MASTRA_PUBLIC_BASE_URL` = the Railway URL (OAuth callbacks + push deep-links).
- `MASTRA_CORS_ORIGINS` + `WEB_APP_ORIGIN` = your Vercel URL.
- Optional per feature: `OPENAI_API_KEY`, marketplace OAuth (Shopee/TikTok/Discord), `ONESIGNAL_*`.
  On Railway's persistent container `DISCORD_EMBEDDED=1` is viable (or run `npm run discord` separately).

The SPA route `/app` returns `503` (not a crash) when no built SPA is present — expected, since the
frontend lives on Vercel. (Mastra Cloud also works as an alternative target via the same `mastra build`.)

### Frontend — Vercel

Import the repo in Vercel with **Root Directory = `lntera-aiag/web`** (`web/vercel.json` sets the
build command, output dir, and SPA rewrite). Set `VITE_API_BASE_URL` to the Railway backend URL. Add
the Vercel origin to the backend's `MASTRA_CORS_ORIGINS`/`WEB_APP_ORIGIN`, and to the Supabase +
OneSignal dashboards. Full runbook: [`web/VERCEL.md`](./web/VERCEL.md).