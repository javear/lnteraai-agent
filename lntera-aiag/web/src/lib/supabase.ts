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

/** Fetch Supabase config from the server (single source of truth — no baked VITE_ secrets). */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  const res = await fetch(apiUrl('/svc/v1/public-config'));
  if (!res.ok) {
    throw new Error(`Server auth config unavailable (public-config returned ${res.status}).`);
  }
  cachedConfig = (await res.json()) as PublicConfig;
  return cachedConfig;
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
