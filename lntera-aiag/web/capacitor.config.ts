import type { CapacitorConfig } from '@capacitor/cli';

// The native shells (iOS/Android via Capacitor, desktop via @capacitor-community/electron) load
// the SAME Vite build from `webDir`. Build it with `npm run build:native` (base '/', no service
// worker). The bundled UI talks to the deployed backend via VITE_API_BASE_URL (baked at build
// time) — so no `server.url` here; assets load locally from the shell. See NATIVE.md.
const config: CapacitorConfig = {
  appId: 'com.lntera.app',
  appName: 'Lntera',
  webDir: 'dist',
  // Generate the native projects as SIBLINGS of web/ (lntera-aiag/android, lntera-aiag/ios)
  // instead of nesting them under web/. Paths are relative to this config (web/). cap sync still
  // copies web/dist into them. See NATIVE.md.
  android: { path: '../android' },
  ios: { path: '../ios' },
  plugins: {
    // OTA web-bundle updates (@capgo/capacitor-updater). autoUpdate:false → WE control the check/download
    // (src/lib/ota.ts) against our self-hosted Supabase manifest. The app still auto-ROLLS BACK to the
    // last-good (or APK-built-in) bundle if a freshly-applied bundle doesn't call notifyAppReady() — so a
    // broken web deploy can't brick the app. Bundles apply on the NEXT launch.
    CapacitorUpdater: {
      autoUpdate: false,
      resetWhenUpdate: true,
    },
  },
};

export default config;
