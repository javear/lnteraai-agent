import { apiErrorMessage } from '../integrations';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export type StudioProjectKind = 'mcp' | 'webapp';
export type StudioProjectStatus = 'draft' | 'deployed' | 'connected' | 'error';

export interface StudioProject {
  id: string;
  name: string;
  kind: StudioProjectKind;
  gitea_repo: string | null;
  deploy_url: string | null;
  mcp_url: string | null;
  /** Persistent "development" deploy URL the agent redeploys to on its own — separate from mcp_url,
   *  which only changes via the user's explicit Publish action. */
  preview_url: string | null;
  status: StudioProjectStatus;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new Error(await apiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

export async function listProjects(api: Api): Promise<StudioProject[]> {
  const { projects } = await json<{ projects: StudioProject[] }>(
    await api('/svc/v1/studio/projects'),
    'Failed to load projects.',
  );
  return projects;
}

export async function createProject(
  api: Api,
  input: { name: string; kind: StudioProjectKind },
): Promise<StudioProject> {
  const { project } = await json<{ project: StudioProject }>(
    await api('/svc/v1/studio/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Failed to create project.',
  );
  return project;
}

export async function getProject(api: Api, id: string): Promise<StudioProject> {
  const { project } = await json<{ project: StudioProject }>(
    await api(`/svc/v1/studio/projects/${id}`),
    'Failed to load project.',
  );
  return project;
}

export async function deleteProject(api: Api, id: string): Promise<void> {
  await json<{ ok: boolean }>(
    await api(`/svc/v1/studio/projects/${id}`, { method: 'DELETE' }),
    'Failed to delete project.',
  );
}

/**
 * Provision the Gitea repo + token; returns a git PATH (e.g. /svc/v1/studio/git/<token>/git). The
 * caller prefixes the current frontend origin (which BrowserPod allow-lists), and the frontend proxies
 * that path to the backend git-proxy — so the pod never needs egress to the backend host.
 */
export async function initProject(api: Api, id: string): Promise<{ project: StudioProject; gitPath: string }> {
  return json<{ project: StudioProject; gitPath: string }>(
    await api(`/svc/v1/studio/projects/${id}/init`, { method: 'POST' }),
    'Failed to initialize project.',
  );
}

/** Ship the built artifacts (base64 zip) to EdgeOne; returns the live subdomain. */
export async function deployProject(
  api: Api,
  id: string,
  zipBase64: string,
): Promise<{ project: StudioProject; url: string }> {
  return json<{ project: StudioProject; url: string }>(
    await api(`/svc/v1/studio/projects/${id}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipBase64 }),
    }),
    'Failed to deploy project.',
  );
}

export interface StudioHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  model?: string;
}

/** Load a page of a project's stored chat history (newest-page-first via `before`, ASC for display). */
export async function getStudioMessages(
  api: Api,
  id: string,
  opts?: { before?: string; limit?: number },
): Promise<{ messages: StudioHistoryMessage[]; hasMore: boolean; nextBefore: string | null }> {
  const params = new URLSearchParams();
  if (opts?.before) params.set('before', opts.before);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return json(
    await api(`/svc/v1/studio/projects/${id}/messages${qs ? `?${qs}` : ''}`),
    'Failed to load chat history.',
  );
}

/** Attach a deployed MCP project to the tenant's business agent. */
export async function connectMcpProject(api: Api, id: string): Promise<StudioProject> {
  const { project } = await json<{ project: StudioProject }>(
    await api(`/svc/v1/studio/projects/${id}/connect`, { method: 'POST' }),
    'Failed to connect project.',
  );
  return project;
}

export interface StudioProjectSecret {
  name: string;
  description: string | null;
  created_at: string;
}

/** List a project's configured secrets — names/descriptions only, never values. */
export async function listProjectSecrets(api: Api, id: string): Promise<StudioProjectSecret[]> {
  const { secrets } = await json<{ secrets: StudioProjectSecret[] }>(
    await api(`/svc/v1/studio/projects/${id}/secrets`),
    'Failed to load secrets.',
  );
  return secrets;
}

/** Register or update a secret for this project. The value is never returned. */
export async function upsertProjectSecret(
  api: Api,
  id: string,
  input: { name: string; value: string; description?: string },
): Promise<void> {
  await json(
    await api(`/svc/v1/studio/projects/${id}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Failed to save the secret.',
  );
}

/** Resolve every configured secret to its plaintext value — feeds the sandbox's env directly
 *  (see BrowserPodProvider.setEnv). Never persist this beyond the current sandbox session. */
export async function getProjectSecretValues(api: Api, id: string): Promise<Record<string, string>> {
  const { values } = await json<{ values: Record<string, string> }>(
    await api(`/svc/v1/studio/projects/${id}/secrets/values`),
    'Failed to load secret values.',
  );
  return values;
}

/** One tool as reported by the MCP server's own tools/list. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/**
 * Proxy one JSON-RPC call to the project's deployed MCP endpoint (server-side, so the EdgeOne
 * function needs no CORS). Returns the upstream JSON-RPC response as-is.
 */
export async function mcpCall(
  api: Api,
  id: string,
  method: string,
  params?: unknown,
  target: 'preview' | 'production' = 'preview',
): Promise<{ status: number; response: { result?: unknown; error?: { code?: number; message?: string } } }> {
  return json(
    await api(`/svc/v1/studio/projects/${id}/mcp-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, target, ...(params !== undefined ? { params } : {}) }),
    }),
    'MCP call failed.',
  );
}
