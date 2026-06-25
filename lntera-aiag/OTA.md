# OTA web updates (native apps)

The native app bundles the web UI inside the APK, so a normal web change would need a new APK. OTA lets
you push **web-only** changes to installed apps without a store release. Native changes (plugins,
permissions, manifest, `capacitor.config`, splash, deep links) still require a rebuilt APK.

## How it works

- Plugin: [`@capgo/capacitor-updater`](https://capgo.app), **self-hosted** on Supabase Storage (public
  bucket `app-bundles`). `autoUpdate: false` — we drive it ourselves in `web/src/lib/ota.ts`.
- **Background mode:** on launch the app calls `notifyAppReady()` (marks the running bundle healthy),
  then checks `app-bundles/latest.json`. If a newer `version` exists, it downloads the bundle **in the
  background** (small non-blocking "Updating… N%" toast) and **stages it for the next launch** (`next()`)
  — the app stays fully usable. A "Restart now" toast action can apply it immediately if the user wants.
- **Rollback safety:** if a freshly-applied bundle fails to boot (never reaches `notifyAppReady()`),
  capgo automatically reverts to the previous good bundle — a broken web deploy can't brick the app.

## Publishing a web update

```bash
cd lntera-aiag/web
SUPABASE_SECRET_KEY=<sb_secret_… key> npm run ota:publish
```

This runs `build:native`, zips `dist` (index.html at the zip root), uploads `<version>.zip` to the
`app-bundles` bucket, and overwrites `latest.json → { version, url }`. (`VITE_SUPABASE_URL` is read from
`.env.native`; the secret key (`sb_secret_…`, the replacement for the legacy `service_role`) is required
for the write and is never bundled into the app. The legacy `SUPABASE_SERVICE_ROLE_KEY` still works as a
fallback.)

Installed apps pick it up on their **next launch**. Version is `<pkg.version>-<timestamp>` (override with
`OTA_VERSION=…`).

## When you DO still need a new APK

- Any change under `android/` (or `ios/`), `capacitor.config.ts`, or added/updated native plugins.
- The first install after adding OTA itself (the APK must contain the capgo plugin).
- Bumping the native `versionCode`/`versionName` for the store.

Ship those via the `mobile-release` branch (Codemagic builds the APK).

## One-time setup status

- [x] Public Supabase bucket `app-bundles` (zip + json, 100 MB limit).
- [x] Plugin installed + synced into Android.
- [ ] Rebuild + install an APK that includes the capgo plugin (via `mobile-release`) before the first
      `ota:publish` can update an installed app.
