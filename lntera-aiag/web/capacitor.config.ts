import type { CapacitorConfig } from '@capacitor/cli';

// The native shells (iOS/Android via Capacitor, desktop via @capacitor-community/electron) load
// the SAME Vite build from `webDir`. Build it with `npm run build:native` (base '/', no service
// worker). The bundled UI talks to the deployed backend via VITE_API_BASE_URL (baked at build
// time) — so no `server.url` here; assets load locally from the shell. See NATIVE.md.
const config: CapacitorConfig = {
  appId: 'com.lntera.app',
  appName: 'Lntera',
  webDir: 'dist',
};

export default config;
