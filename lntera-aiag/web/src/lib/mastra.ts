import { useMemo } from 'react';
import { MastraClient } from '@mastra/client-js';
import { useAuth } from '../auth';
import { API_BASE } from './runtime';

/** Matches the server agent id (src/mastra/agents/general-agent.ts). */
export const AGENT_ID = 'general-agent';

export function makeMastraClient(token: string | undefined): MastraClient {
  return new MastraClient({
    // Same-origin on web; the configured remote backend in native/Electron shells.
    baseUrl: API_BASE || window.location.origin,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Memoized client; recreated when the Supabase access token refreshes so the Bearer stays current. */
export function useMastra(): MastraClient {
  const { session } = useAuth();
  const token = session?.access_token;
  return useMemo(() => makeMastraClient(token), [token]);
}
