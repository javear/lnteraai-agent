import { getPortkeyAdminApiKey, getPortkeyBaseUrl, getPortkeyWorkspaceId } from './config';

export class PortkeyAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'PortkeyAdminError';
  }
}

type PortkeyJson = Record<string, unknown>;

function appendWorkspaceQuery(path: string, workspaceId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}workspace_id=${encodeURIComponent(workspaceId)}`;
}

/** Pull a human message out of the various shapes Portkey returns ({message}, {error}, {error:{message}}). */
function extractPortkeyMessage(parsed: unknown): string | null {
  if (!parsed) return null;
  if (typeof parsed === 'string') return parsed.trim() || null;
  if (typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.trim()) return o.message;
    const e = o.error;
    if (typeof e === 'string' && e.trim()) return e;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
  }
  return null;
}

function formatPortkeyAdminErrorMessage(
  method: string,
  path: string,
  status: number,
  parsed: unknown,
): string {
  const fromBody = extractPortkeyMessage(parsed);
  // Always keep the actual server reason visible — a bare "(400)" is undiagnosable.
  const detail = fromBody
    ? fromBody
    : parsed
      ? JSON.stringify(parsed).slice(0, 300)
      : '';
  let msg = `Portkey Admin API ${method} ${path} failed (${status})${detail ? `: ${detail}` : ''}`;

  if (status === 403) {
    const hints: string[] = [
      'Confirm PORTKEY_ADMIN_API_KEY is a Service Account with workspace_integrations create/read/update (not the inference PORTKEY_API_KEY alone).',
    ];
    const workspaceId = getPortkeyWorkspaceId();
    if (!workspaceId) {
      hints.push(
        'If this is an organisation admin key, set PORTKEY_WORKSPACE_ID to your Portkey workspace slug or UUID.',
      );
    } else {
      hints.push(
        `PORTKEY_WORKSPACE_ID is set (${workspaceId}) — it must match the workspace this admin key belongs to. For a workspace-scoped admin key, remove PORTKEY_WORKSPACE_ID instead.`,
      );
    }
    msg = `${msg} ${hints.join(' ')}`;
  }

  return msg;
}

async function portkeyAdminFetch(
  path: string,
  init: RequestInit & { method: string },
): Promise<PortkeyJson> {
  const workspaceId = getPortkeyWorkspaceId();
  let requestPath = path.startsWith('/') ? path : `/${path}`;

  // Org admin keys need workspace_id on GET/DELETE (query); POST/PUT use body merge below.
  if (
    workspaceId &&
    (init.method === 'GET' || init.method === 'DELETE')
  ) {
    requestPath = appendWorkspaceQuery(requestPath, workspaceId);
  }

  const url = `${getPortkeyBaseUrl()}${requestPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-portkey-api-key': getPortkeyAdminApiKey(),
    ...(init.headers as Record<string, string> | undefined),
  };

  const body =
    init.body && workspaceId && init.method !== 'GET' && init.method !== 'DELETE'
      ? mergeWorkspaceId(JSON.parse(String(init.body)), workspaceId)
      : init.body;

  const res = await fetch(url, { ...init, headers, body: body ?? init.body });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new PortkeyAdminError(
      formatPortkeyAdminErrorMessage(init.method, path, res.status, parsed),
      res.status,
      parsed,
    );
  }

  return (parsed && typeof parsed === 'object' ? parsed : {}) as PortkeyJson;
}

function mergeWorkspaceId(body: PortkeyJson, workspaceId: string): string {
  if (body.workspace_id || body.workspaceId) {
    return JSON.stringify(body);
  }
  return JSON.stringify({ ...body, workspace_id: workspaceId });
}

export interface PortkeyIntegrationRecord {
  id: string;
  slug: string;
}

export interface PortkeyProviderRecord {
  id: string;
  slug: string;
}

export async function createPortkeyIntegration(input: {
  name: string;
  slug: string;
  apiKey: string;
  /** Portkey `ai_provider_id` (e.g. `groq`, `google`). Defaults to `groq` for back-compat. */
  aiProviderId?: string;
}): Promise<PortkeyIntegrationRecord> {
  const data = await portkeyAdminFetch('/integrations', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      ai_provider_id: input.aiProviderId ?? 'groq',
      key: input.apiKey,
    }),
  });
  return {
    id: String(data.id ?? ''),
    slug: String(data.slug ?? input.slug),
  };
}

export async function updatePortkeyIntegration(input: {
  integrationId: string;
  apiKey: string;
}): Promise<void> {
  await portkeyAdminFetch(`/integrations/${encodeURIComponent(input.integrationId)}`, {
    method: 'PUT',
    body: JSON.stringify({ key: input.apiKey }),
  });
}

/** Portkey may return 403 (AB03) when a slug is absent in the target workspace — treat like 404. */
function isPortkeyRetrieveMiss(err: unknown): boolean {
  return err instanceof PortkeyAdminError && (err.status === 404 || err.status === 403);
}

export async function retrievePortkeyIntegrationBySlug(
  slug: string,
): Promise<PortkeyIntegrationRecord | null> {
  try {
    const data = await portkeyAdminFetch(`/integrations/${encodeURIComponent(slug)}`, {
      method: 'GET',
    });
    return {
      id: String(data.id ?? ''),
      slug: String(data.slug ?? slug),
    };
  } catch (err) {
    if (isPortkeyRetrieveMiss(err)) return null;
    throw err;
  }
}

export async function createPortkeyProvider(input: {
  name: string;
  slug: string;
  integrationSlug: string;
}): Promise<PortkeyProviderRecord> {
  const data = await portkeyAdminFetch('/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      integration_id: input.integrationSlug,
    }),
  });
  return {
    id: String(data.id ?? ''),
    slug: String(data.slug ?? input.slug),
  };
}

export async function retrievePortkeyProviderBySlug(
  slug: string,
): Promise<PortkeyProviderRecord | null> {
  try {
    const data = await portkeyAdminFetch(`/providers/${encodeURIComponent(slug)}`, {
      method: 'GET',
    });
    return {
      id: String(data.id ?? ''),
      slug: String(data.slug ?? slug),
    };
  } catch (err) {
    if (isPortkeyRetrieveMiss(err)) return null;
    throw err;
  }
}

export async function deletePortkeyProvider(providerId: string): Promise<void> {
  await portkeyAdminFetch(`/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export async function deletePortkeyIntegration(integrationId: string): Promise<void> {
  await portkeyAdminFetch(`/integrations/${encodeURIComponent(integrationId)}`, {
    method: 'DELETE',
  });
}

/**
 * Lightweight validation chat completion through Portkey inference API.
 *
 * A `429` (rate-limit / quota) is treated as **valid** rather than an error: it proves the key
 * authenticated against the provider (auth failures are 401/403/400), so the connect should
 * succeed — runtime calls roll across models/providers and cool down as needed. Returns
 * `{ rateLimited }` so the caller can record that full validation was deferred.
 */
export async function validateProviderViaPortkey(input: {
  providerSlug: string;
  /** Portkey model segment to validate against (e.g. `llama-3.1-8b-instant`, `gemini-2.0-flash-lite`). */
  model: string;
  inferenceApiKey: string;
  /** For clearer error messages (e.g. `Groq`, `Gemini`). */
  providerLabel?: string;
}): Promise<{ rateLimited: boolean }> {
  const url = `${getPortkeyBaseUrl()}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-portkey-api-key': input.inferenceApiKey,
    },
    body: JSON.stringify({
      model: `@${input.providerSlug}/${input.model}`,
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      max_tokens: 8,
    }),
  });

  if (res.ok) return { rateLimited: false };

  // Quota/rate-limit → the key is valid; don't fail the connect.
  if (res.status === 429) return { rateLimited: true };

  const text = await res.text();
  throw new Error(
    `Portkey ${input.providerLabel ?? 'provider'} validation failed (${res.status}): ${text.slice(0, 400)}`,
  );
}

/** @deprecated Use {@link validateProviderViaPortkey}. */
export async function validateGroqViaPortkey(input: {
  providerSlug: string;
  inferenceApiKey: string;
}): Promise<void> {
  await validateProviderViaPortkey({
    providerSlug: input.providerSlug,
    model: 'llama-3.1-8b-instant',
    inferenceApiKey: input.inferenceApiKey,
    providerLabel: 'Groq',
  });
}
