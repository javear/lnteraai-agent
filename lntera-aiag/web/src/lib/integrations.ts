/** Advanced/BYOK provider status: also carries the tenant's allowed model codes. */
export interface AdvancedLlmStatus {
  status: string;
  connectedAt: string | null;
  selectedModels: string[];
}

export interface IntegrationStatus {
  discord: { connected: boolean; guildId: string | null; channelId: string | null };
  groq: { status: string; connectedAt: string | null };
  gemini: { status: string; connectedAt: string | null };
  openai: AdvancedLlmStatus;
  anthropic: AdvancedLlmStatus;
  openrouter: AdvancedLlmStatus;
  shopee: { connectionId: string; shopId: string; shopName: string | null }[];
  tiktok: { connectionId: string; openId: string; shopName: string | null; region: string | null }[];
}

/** Advanced/BYOK provider codes (user-supplied models, pin-only in the chain). */
export const ADVANCED_LLM_CODES = ['openai', 'anthropic', 'openrouter'] as const;
export type AdvancedLlmCode = (typeof ADVANCED_LLM_CODES)[number];

/** One model the tenant can pin in the chat box (from GET /svc/v1/me/models). */
export interface PinnableModel {
  modelCode: string;
  segment: string;
  providerCode: string;
  providerName: string;
  tier: 'free' | 'advanced';
  label: string;
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

/** The models the current tenant can pin in the chat box (empty when nothing is connected). */
export async function fetchPinnableModels(api: Api): Promise<PinnableModel[]> {
  const res = await api('/svc/v1/me/models');
  if (!res.ok) throw new Error(`Failed to load models (${res.status}).`);
  const data = (await res.json()) as { models?: PinnableModel[] };
  return data.models ?? [];
}

export function isGroqActive(s: IntegrationStatus | null): boolean {
  return s?.groq.status === 'active';
}

export function isGeminiActive(s: IntegrationStatus | null): boolean {
  return s?.gemini?.status === 'active';
}

/** Strictly BYO: the agent can run as soon as ANY LLM provider is connected (free or advanced). */
export function isAnyLlmActive(s: IntegrationStatus | null): boolean {
  if (isGroqActive(s) || isGeminiActive(s)) return true;
  return ADVANCED_LLM_CODES.some((c) => s?.[c]?.status === 'active');
}

/** Shared via React Router's Outlet context so the shell + pages stay in sync. */
export interface AppOutletContext {
  status: IntegrationStatus | null;
  loadingStatus: boolean;
  /** Pass `fresh: true` after a connect/disconnect to bypass the cached status. */
  refreshStatus: (fresh?: boolean) => Promise<void>;
}
