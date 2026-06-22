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

## Native OAuth / connect flow

The web/PWA flow opens OAuth in a **popup (desktop) / new tab (mobile)** that closes itself, with the
app updating live via Supabase Realtime (`lib/oauth-popup.ts`, `pages/Integrations.tsx`,
`auth.tsx signInGoogle`). Inside a Capacitor WebView there's no popup/opener model, so `runtime.ts`
`IS_NATIVE` switches both flows to a graceful fallback that already works today:

- **Marketplace connect** (`connectOAuth`): opens the connect URL in the **system browser**
  (`window.open(url, '_blank')`). The app stays alive and refreshes the moment the backend broadcasts
  the `connection` Realtime event — so when the user returns to the app, the store is already there.
- **Google SSO** (`signInGoogle`): falls back to a **full-page redirect** (the popup/cross-tab model
  doesn't apply in the WebView). Email/password + email-code login also work out of the box.

### Upgrade to an in-app browser that auto-dismisses (v1.1 — needs a device + a dep install)

The dependency must be installed locally (the CI sandbox has no npm-registry access):

```bash
cd web
npm i @capacitor/browser     # in-app browser (SFSafariViewController / Chrome Custom Tab)
npm i @capacitor/app         # appUrlOpen deep-link listener (for Google SSO)
```

Then:
- **Marketplace connect**: in the `IS_NATIVE` branch of `connectOAuth`, swap `window.open` for
  `Browser.open({ url })`, and call `Browser.close()` from the Realtime `connection` handler. The
  backend result page is unchanged — nothing to do server-side.
- **Google SSO**: register a custom URL scheme (e.g. `lntera://auth`), use it as the Supabase
  `redirectTo`, open Google with `Browser.open`, add `App.addListener('appUrlOpen', …)` to feed the
  returned `code` to `supabase.auth.exchangeCodeForSession(...)`, then `Browser.close()`. Allow-list
  the scheme in Supabase Auth → URL Configuration, and test on a real device.
