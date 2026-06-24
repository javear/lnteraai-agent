# Mobile CI — GitHub Actions → Firebase App Distribution

`mobile-release` branch → GitHub Actions (`.github/workflows/mobile-release.yml`) → Firebase App
Distribution. Push to `mobile-release` (merge `main` into it) or run the workflow manually from the
Actions tab. Android is live; iOS is a ready-to-enable job that needs Apple signing.

> OTA (web-only) updates are separate — those ship via `npm run ota:publish` without a new build. Use
> this CI only for native/major changes. See `OTA.md`.

## Cut a build
```bash
git checkout mobile-release && git merge main && git push
```

## Firebase setup (one time)
1. In the Firebase console, add your apps under the project: an **Android** app with package
   `com.lntera.app`, and (for iOS) an **iOS** app with bundle id `com.lntera.app`.
2. Create a **service account** with the **Firebase App Distribution Admin** role
   (Project settings → Service accounts → Generate new private key) and copy the JSON.
3. Add testers to a group named **`testers`** in App Distribution (or change `groups:` in the workflow).

## Required GitHub repo secrets (Settings → Secrets and variables → Actions)
| Secret | For | Value |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | both | the service-account JSON (whole file contents) |
| `FIREBASE_ANDROID_APP_ID` | Android | Firebase Android app id, e.g. `1:123…:android:abc…` |
| `FIREBASE_IOS_APP_ID` | iOS | Firebase iOS app id, e.g. `1:123…:ios:abc…` |

The public build values (`VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_WEB_APP_ORIGIN`) are set in the workflow `env:` block — edit there if they change.

## Android (works now)
Builds a **debug** APK (signed with the debug key — matches the `assetlinks.json` debug fingerprint, so
App Links verify) and:
- always uploads it as a workflow **artifact** (`app-debug-apk`), even before Firebase is set up;
- distributes to Firebase when `FIREBASE_ANDROID_APP_ID` + `FIREBASE_SERVICE_ACCOUNT` exist.

For a **release-signed** APK/AAB later: add the keystore as secrets, switch the gradle task to
`assembleRelease`/`bundleRelease` with a signing config, and add the release SHA-256 to `assetlinks.json`.

## iOS (enable after Apple signing is ready)
The `ios` job is gated `if: ${{ false }}`. To turn it on:
1. Apple Developer Program account. Create a **distribution certificate** (`.p12`) and an **ad-hoc**
   (or development) **provisioning profile** for `com.lntera.app` with your testers' device UDIDs
   registered (Firebase App Distribution installs ad-hoc/dev builds).
2. Create an `ExportOptions.plist` (method `ad-hoc` or `development`, your `teamID`, signing style).
3. Base64-encode and add as secrets:
   - `IOS_DIST_CERT_P12_BASE64` = `base64 -i dist.p12`
   - `IOS_DIST_CERT_PASSWORD`
   - `IOS_PROVISIONING_PROFILE_BASE64` = `base64 -i profile.mobileprovision`
   - `IOS_EXPORT_OPTIONS_PLIST_BASE64` = `base64 -i ExportOptions.plist`
4. Flip the `ios` job's `if: ${{ false }}` to `if: ${{ true }}`.

The iOS Capacitor project is generated on the macOS runner (`cap add ios`) — no need to commit it.
