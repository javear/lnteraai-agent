import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { apiUrl } from './runtime';

export interface PublicConfig {
  supabaseUrl: string;
  supabaseKey: string;
  /** OneSignal app id for web/native push (browser-safe). Null when push isn't configured. */
  oneSignalAppId?: string | null;
  /** OneSignal Safari web id (browser-safe). Null when push isn't configured. */
  oneSignalSafariWebId?: string | null;
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
 * Fetch Supabase config from the server (single source of truth — no baked VITE_ secrets).
 *
 * Resilient by design so a backend cold start never becomes a hard "failed to fetch":
 *  - retries with backoff (~7s total) to ride out a waking Railway dyno or a brief network blip;
 *  - on success, caches the config in localStorage;
 *  - if the network is exhausted, boots from the last-good cached config when available.
 * Only throws (→ the boot "Try again" screen) when there is no network AND no cached config.
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
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
