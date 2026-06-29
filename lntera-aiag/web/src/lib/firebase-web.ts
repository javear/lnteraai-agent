// Firebase telemetry for the WEB / PWA target only (Analytics + Performance). The native app uses the
// @capacitor-firebase plugins instead (see analytics.ts). Everything is env-gated: with no Firebase
// config the whole module no-ops, so dev and self-hosters without Firebase are unaffected. Config is
// build-time (VITE_FIREBASE_*) since Analytics initializes client-side.
import type { Analytics } from 'firebase/analytics';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
};

/** Configured = the minimum needed to init the app. Analytics additionally needs measurementId. */
function isConfigured(): boolean {
  return Boolean(config.apiKey && config.appId && config.projectId);
}

let started = false;
let analytics: Analytics | null = null;

/** Init the Firebase web app + Performance, and Analytics when supported. Idempotent; no-op if unconfigured. */
export async function initWebTelemetry(): Promise<void> {
  if (started || !isConfigured()) return;
  started = true;
  try {
    const { initializeApp } = await import('firebase/app');
    const app = initializeApp(config as Record<string, string>);

    // Performance Monitoring — fire-and-forget; safe where supported.
    void import('firebase/performance')
      .then(({ getPerformance }) => getPerformance(app))
      .catch(() => {});

    // Analytics — only in supported environments (needs cookies/IndexedDB + a measurementId).
    if (config.measurementId) {
      const { isSupported, getAnalytics } = await import('firebase/analytics');
      if (await isSupported().catch(() => false)) analytics = getAnalytics(app);
    }
  } catch {
    started = false; // allow a later retry
  }
}

export async function webLogEvent(name: string, params?: Record<string, unknown>): Promise<void> {
  if (!analytics) return;
  try {
    const { logEvent } = await import('firebase/analytics');
    logEvent(analytics, name, params);
  } catch {
    /* ignore */
  }
}

export async function webSetUser(id: string | null): Promise<void> {
  if (!analytics) return;
  try {
    const { setUserId } = await import('firebase/analytics');
    setUserId(analytics, id);
  } catch {
    /* ignore */
  }
}
