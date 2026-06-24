import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { apiUrl } from './runtime';

export interface PublicConfig {
  supabaseUrl: string;
  supabaseKey: string;
  /** OneSignal app id for web/native push (browser-safe). Null when push isn't configured. */
  oneSignalAppId?: string | null;
  /** OneSignal Safari web id (browser-safe). Null when push isn't configured. */
  oneSignalSafariWebId?: string | null;
  /** Google Web OAuth client id for One Tap (browser-safe). Null when not configured. */
  googleClientId?: string | null;
}

let cachedConfig: PublicConfig | null = null;

/** localStorage key for the last-good public config — lets the app boot when the backend is briefly
 *  unreachable (Railway cold start, flaky mobile network on PWA launch). It holds no secrets beyond
 *  the already-public Supabase URL + anon key + OneSignal ids. */
const CONFIG_CACHE_KEY = 'lntera-public-config';

function loadCachedConfig(): PublicConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PublicConfig) : null;
  } catch {
    return null;
  }
}

function saveCachedConfig(cfg: PublicConfig): void {
  try {
    localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg));
  } catch {
    /* private mode / quota — keep the in-memory copy */
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Native builds bake the (already-public) Supabase URL + anon key at build time so a cold start renders
 * INSTANTLY instead of blocking the boot splash on a network round-trip to the backend for /public-config.
 * Web intentionally does NOT bake these (single source of truth, secrets out of the served bundle) — the
 * native build simply sets VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (+ optional push/google ids).
 */
function bakedConfig(): PublicConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) return null;
  return {
    supabaseUrl: url,
    supabaseKey: key,
    oneSignalAppId: (import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined) || null,
    oneSignalSafariWebId: (import.meta.env.VITE_ONESIGNAL_SAFARI_WEB_ID as string | undefined) || null,
    googleClientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || null,
  };
}

/**
 * Fetch Supabase config from the server (single source of truth — no baked VITE_ secrets).
 *
 * Resilient by design so a backend cold start never becomes a hard "failed to fetch":
 *  - retries with backoff (~7s total) to ride out a waking Railway dyno or a brief network blip;
 *  - on success, caches the config in localStorage;
 *  - if the network is exhausted, boots from the last-good cached config when available.
 * Only throws (→ the boot "Try again" screen) when there is no network AND no cached config.
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  // Native: boot INSTANTLY from the build-time config — no boot-blocking round-trip for /public-config.
  // Enrich with server-only fields (OneSignal / Google ids) in the background so push + One Tap still
  // work, without ever delaying first paint. The Supabase url/key always stay the baked values.
  const baked = bakedConfig();
  if (baked) {
    cachedConfig = { ...(loadCachedConfig() ?? {}), ...baked };
    saveCachedConfig(cachedConfig);
    void (async () => {
      try {
        const res = await fetch(apiUrl('/svc/v1/public-config'));
        if (!res.ok) return;
        const full = (await res.json()) as PublicConfig;
        cachedConfig = { ...full, supabaseUrl: baked.supabaseUrl, supabaseKey: baked.supabaseKey };
        saveCachedConfig(cachedConfig);
      } catch {
        /* offline — the baked values stand */
      }
    })();
    return cachedConfig;
  }

  const backoffs = [0, 800, 2000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      const res = await fetch(apiUrl('/svc/v1/public-config'));
      if (!res.ok) throw new Error(`public-config returned ${res.status}`);
      const cfg = (await res.json()) as PublicConfig;
      cachedConfig = cfg;
      saveCachedConfig(cfg);
      return cfg;
    } catch (err) {
      lastErr = err;
    }
  }
  // Network exhausted — fall back to the last config we saw so the app can still start.
  const cached = loadCachedConfig();
  if (cached) {
    cachedConfig = cached;
    return cached;
  }
  throw new Error(
    `Couldn't reach the server to start up — check your connection and try again. (${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  );
}

/** The public config fetched at boot — available synchronously to later consumers (e.g. push init). */
export function getPublicConfig(): PublicConfig | null {
  return cachedConfig;
}

export function makeSupabase(cfg: PublicConfig): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
}
