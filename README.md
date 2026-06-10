# lnteraai-agent

Monorepo for the Lntera AI agent platform.

```
lntera-aiag/        # Mastra backend (agents, tools, server API) → deploys to Mastra Cloud
  web/              # React + Vite frontend (chat + integrations UI) → deploys to Vercel
  supabase/         # SQL migrations + Supabase setup notes
```

## Where to start

- **Backend setup, env, and deployment** → [`lntera-aiag/README.md`](lntera-aiag/README.md)
- **Backend → Railway (Docker) deploy** → [`lntera-aiag/RAILWAY.md`](lntera-aiag/RAILWAY.md)
- **Frontend → Vercel deploy** → [`lntera-aiag/web/VERCEL.md`](lntera-aiag/web/VERCEL.md)
- **Native (Capacitor/Electron)** → [`lntera-aiag/web/NATIVE.md`](lntera-aiag/web/NATIVE.md)

```shell
cd lntera-aiag
cp .env.example .env     # fill in the values
npm install
npm run dev              # backend (Mastra Studio at http://localhost:4111)
npm run dev:web          # frontend (in another terminal)
```

In production the backend runs on **Railway** (Docker) and the frontend on **Vercel** (separate
origins, Bearer-token auth); pushing to `main` auto-deploys both. See the backend README's
*Deployment* section + [`RAILWAY.md`](lntera-aiag/RAILWAY.md) for the full runbook and required env vars.
