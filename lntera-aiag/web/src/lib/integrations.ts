export interface IntegrationStatus {
  discord: { connected: boolean; guildId: string | null; channelId: string | null };
  groq: { status: string; connectedAt: string | null };
  gemini: { status: string; connectedAt: string | null };
  shopee: { connectionId: string; shopId: string; shopName: string | null }[];
  tiktok: { connectionId: string; openId: string; shopName: string | null; region: string | null }[];
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** Pull the human message out of our `{ error: { code, message } }` envelope (or legacy `{ message }`). */
export async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
  return d.error?.message || d.message || fallback;
}

export async function fetchIntegrationStatus(api: Api, fresh = false): Promise<IntegrationStatus> {
  // `fresh` busts the service-worker StaleWhileRevalidate cache (unique URL → network) so a just-
  // connected/disconnected provider shows immediately instead of the previous cached status.
  const path = fresh ? `/svc/v1/me/integrations?_=${Date.now()}` : '/svc/v1/me/integrations';
  const res = await api(path);
  if (!res.ok) throw new Error(`Failed to load integration status (${res.status}).`);
  return (await res.json()) as IntegrationStatus;
}

export function isGroqActive(s: IntegrationStatus | null): boolean {
  return s?.groq.status === 'active';
}

export function isGeminiActive(s: IntegrationStatus | null): boolean {
  return s?.gemini?.status === 'active';
}

/** Strictly BYO: the agent can run as soon as ANY LLM provider is connected. */
export function isAnyLlmActive(s: IntegrationStatus | null): boolean {
  return isGroqActive(s) || isGeminiActive(s);
}

/** Shared via React Router's Outlet context so the shell + pages stay in sync. */
export interface AppOutletContext {
  status: IntegrationStatus | null;
  loadingStatus: boolean;
  /** Pass `fresh: true` after a connect/disconnect to bypass the cached status. */
  refreshStatus: (fresh?: boolean) => Promise<void>;
}
