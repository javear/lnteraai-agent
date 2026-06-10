# Deploying the web app to Vercel (standalone)

The same Vite codebase powers three targets — the `base` knob drives every path:

| Target | Command | base | Output | Service worker | API |
| --- | --- | --- | --- | --- | --- |
| Web — served by Mastra at `/app` | `npm run build` | `/app/` | `../src/mastra/public/app` | on (PWA) | same-origin |
| **Vercel — standalone at root** | `npm run build:vercel` | `/` | `web/dist` | on (PWA) | `VITE_API_BASE_URL` (cross-origin) |
| Native (Capacitor / Electron) | `npm run build:native` | `/` | `web/dist` | off | `VITE_API_BASE_URL` |

On Vercel the app is hosted at its own origin and calls the Mastra backend cross-origin. Auth is
`Authorization: Bearer` (no cookies) and Supabase creds are fetched at runtime from
`/svc/v1/public-config`, so the only frontend secret-free env you need is the backend URL.

## Vercel project setup

1. **Import the repo** into Vercel. Set **Root Directory** = `lntera-aiag/web`.
   (`web/vercel.json` already sets the build command, `dist` output, and the SPA rewrite — Vercel will
   pick it up; the framework preset can stay "Vite" or "Other".)
2. **Environment variable** (Production + Preview):

   ```
   VITE_API_BASE_URL=https://your-backend.example.com
   ```

   This is baked into the bundle at build time and prefixes every `/svc/v1/*` and `/api/*` call
   (`src/lib/runtime.ts` → `apiUrl()`).
3. Deploy. Client-side routing (`/c/:id`, `/integrations`, `/login`) is handled by the rewrite in
   `vercel.json` (`/(.*) → /index.html`); real files (`/assets/*`, `/sw.js`, `/manifest.webmanifest`,
   `/onesignal/OneSignalSDKWorker.js`) are served directly.

## Backend configuration (the deployed Mastra server)

| Env | Value | Why |
| --- | --- | --- |
| `MASTRA_CORS_ORIGINS` | `https://your-app.vercel.app` (comma-add `http://localhost:4173` for local preview) | Allow the Vercel origin to call the API. Bearer auth → credentials off with an explicit allowlist is correct. |
| `WEB_APP_ORIGIN` | `https://your-app.vercel.app` | Server redirects (OAuth callbacks, `/auth`) and push deep-links target the Vercel app instead of `/app`. Leave unset to keep the legacy `<server>/app` behavior. |

## Dashboard allowlists (one-time)

- **Supabase** → Authentication → URL Configuration: add `https://your-app.vercel.app/login` (and
  `http://localhost:4173/login` for local preview) to the redirect allowlist (Google OAuth).
- **OneSignal** → Web Push config: add `https://your-app.vercel.app` as an allowed site origin.

## Local check before deploying

```bash
# Terminal 1: backend with the Vercel preview origin allowed
MASTRA_CORS_ORIGINS=http://localhost:4173 WEB_APP_ORIGIN=http://localhost:4173 <run the Mastra server>

# Terminal 2: build + preview the Vercel target against the local backend
cd web
VITE_API_BASE_URL=http://localhost:4111 npm run build:vercel
npm run preview:vercel   # serves web/dist at http://localhost:4173
```

Then load `http://localhost:4173` → sign in, chat (streaming), and integrations status should all work
cross-origin; deep links resolve at root.

> Note: the Mastra-served `/app` build (`npm run build` / `npm run dev`) and the native build are
> unaffected — Vercel is an additional, opt-in target.
