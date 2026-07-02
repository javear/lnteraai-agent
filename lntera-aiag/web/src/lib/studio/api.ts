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

/** Provision Gitea repo + token; returns a clone URL that routes through our token-injecting proxy. */
export async function initProject(api: Api, id: string): Promise<{ project: StudioProject; cloneUrl: string }> {
  return json<{ project: StudioProject; cloneUrl: string }>(
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

/** Attach a deployed MCP project to the tenant's business agent. */
export async function connectMcpProject(api: Api, id: string): Promise<StudioProject> {
  const { project } = await json<{ project: StudioProject }>(
    await api(`/svc/v1/studio/projects/${id}/connect`, { method: 'POST' }),
    'Failed to connect project.',
  );
  return project;
}
