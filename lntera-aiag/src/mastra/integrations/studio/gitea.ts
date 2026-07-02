import { getGiteaConfig } from './config';

export interface GiteaRepo {
  fullName: string; // "owner/name"
  cloneUrl: string; // https clone URL on Gitea
  htmlUrl: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

/**
 * Create (or reuse) a private repo under the configured org for a Studio project. Idempotent: a 409
 * "already exists" falls back to fetching the existing repo. Requires Gitea env config.
 */
export async function createGiteaRepo(name: string): Promise<GiteaRepo> {
  const cfg = getGiteaConfig();
  if (!cfg) throw new Error('Gitea is not configured (set GITEA_BASE_URL, GITEA_TOKEN, GITEA_OWNER).');

  const res = await fetch(`${cfg.baseUrl}/api/v1/orgs/${encodeURIComponent(cfg.owner)}/repos`, {
    method: 'POST',
    headers: authHeaders(cfg.token),
    body: JSON.stringify({ name, private: true, auto_init: true, default_branch: 'main' }),
  });

  if (res.ok) return toRepo(await res.json());
  if (res.status === 409) return getGiteaRepo(name);
  throw new Error(`Gitea repo create failed (${res.status}): ${await safeText(res)}`);
}

export async function getGiteaRepo(name: string): Promise<GiteaRepo> {
  const cfg = getGiteaConfig();
  if (!cfg) throw new Error('Gitea is not configured.');
  const res = await fetch(
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(name)}`,
    { headers: authHeaders(cfg.token) },
  );
  if (!res.ok) throw new Error(`Gitea repo fetch failed (${res.status}): ${await safeText(res)}`);
  return toRepo(await res.json());
}

function toRepo(json: unknown): GiteaRepo {
  const r = json as { full_name?: string; clone_url?: string; html_url?: string };
  if (!r.full_name || !r.clone_url) throw new Error('Unexpected Gitea repo payload.');
  return { fullName: r.full_name, cloneUrl: r.clone_url, htmlUrl: r.html_url ?? r.clone_url };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
