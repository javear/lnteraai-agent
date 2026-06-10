# Native shells (Capacitor iOS/Android + Electron)

The same Vite build powers three targets:

| Target | Command | base | Service worker | API |
| --- | --- | --- | --- | --- |
| Web (served by Mastra at `/app`) | `npm run build` | `/app/` | on (PWA) | same-origin |
| Native (Capacitor / Electron) | `npm run build:native` | `/` | off | `VITE_API_BASE_URL` |

In native shells the UI loads locally (`capacitor://localhost` / `file://`), so it must point at the
**deployed backend**. Set it at build time:

```bash
# web/.env.native (or pass inline)
VITE_API_BASE_URL=https://your-backend.example.com
```

`src/lib/runtime.ts` exposes `IS_NATIVE`, `API_BASE`, and `apiUrl()`; every network call (auth,
`/svc/v1/*`, the Mastra client, Supabase config) routes through it. Routing uses `HashRouter` in
native (no server to resolve deep links).

## One-time setup (requires native toolchains — run locally)

```bash
cd web
npm i -D @capacitor/cli
npm i @capacitor/ios @capacitor/android @capacitor-community/electron   # platforms (added on demand)
npm run build:native

npx cap add ios          # needs Xcode
npx cap add android      # needs Android Studio / JDK
npx cap add @capacitor-community/electron   # desktop
```

## Iterate

```bash
npm run cap:sync         # build:native + cap sync (copies dist into each platform)
npx cap open ios         # / android / @capacitor-community/electron
```

## Push notifications (OneSignal)

- Web/Electron push uses the OneSignal **Web SDK** (already wired via `react-onesignal`).
- iOS/Android push uses **`onesignal-cordova-plugin`** (already a dep; the web build aliases it to a
  no-op stub so it never bundles into the browser app). Configure **APNs** (iOS) and **FCM**
  (Android) in the OneSignal dashboard. `initPush` registers `external_id = user uuid` + tag
  `tenant_id`; the server targets the tenant tag. No OneSignal ids are stored in our DB.

## Known follow-up: native OAuth

Google sign-in (and marketplace OAuth `connect-url`) currently redirect via the browser, which works
on web/Electron but not inside the Capacitor WebView. **Native v1 uses email/password** (works out of
the box). Deep-link OAuth (custom scheme + `@capacitor/app` `appUrlOpen` listener feeding the token
back to Supabase) is a later add.
