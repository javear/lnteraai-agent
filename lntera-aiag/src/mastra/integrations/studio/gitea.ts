import { getGiteaConfig } from './config';

/** Derive a stable, unique external-service project name from a Studio project id — shared by every
 *  integration keyed on "the project's name elsewhere" (Gitea repo, EdgeOne project). */
export function repoNameFor(projectId: string): string {
  return `studio-${projectId.slice(0, 8)}`;
}

export interface GiteaRepo {
  fullName: string; // "owner/name"
  cloneUrl: string; // https clone URL on Gitea
  htmlUrl: string;
  /** True only on the actual creation path — false when an existing repo was reused (409). Callers
   *  that seed a starter template on first creation use this to avoid re-seeding (and clobbering
   *  the tenant's own work) on a later reconnect/re-init of the same project. */
  created: boolean;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'lntera-studio',
  };
}

/**
 * Create (or reuse) a private repo under the TOKEN'S OWN USER for a Studio project. We use
 * `/user/repos` (needs only `write:repository`) rather than an org endpoint, so no org / org-scope is
 * required — tenant isolation is enforced by the app + the signed git-proxy token, not by the Gitea
 * account. Idempotent: a 409 "already exists" falls back to finding the existing repo.
 */
export async function createGiteaRepo(name: string): Promise<GiteaRepo> {
  const cfg = getGiteaConfig();
  if (!cfg) throw new Error('Gitea is not configured (set GITEA_BASE_URL and GITEA_TOKEN).');

  const res = await fetch(`${cfg.baseUrl}/api/v1/user/repos`, {
    method: 'POST',
    headers: authHeaders(cfg.token),
    body: JSON.stringify({ name, private: true, auto_init: true, default_branch: 'main' }),
  });

  if (res.ok) return toRepo(await res.json(), true);
  if (res.status === 409) return findUserRepo(name);
  throw new Error(`Gitea repo create failed (${res.status}): ${await safeText(res)}`);
}

/** Find one of the token user's repos by name (used as the idempotent reuse path). */
async function findUserRepo(name: string): Promise<GiteaRepo> {
  const cfg = getGiteaConfig();
  if (!cfg) throw new Error('Gitea is not configured.');
  const res = await fetch(`${cfg.baseUrl}/api/v1/user/repos?limit=50`, { headers: authHeaders(cfg.token) });
  if (!res.ok) throw new Error(`Gitea repo list failed (${res.status}): ${await safeText(res)}`);
  const list = (await res.json()) as unknown[];
  const match = list.find((r) => (r as { name?: string }).name === name);
  if (!match) throw new Error(`Gitea repo "${name}" exists but could not be located.`);
  return toRepo(match, false);
}

function toRepo(json: unknown, created: boolean): GiteaRepo {
  const r = json as { full_name?: string; clone_url?: string; html_url?: string };
  if (!r.full_name || !r.clone_url) throw new Error('Unexpected Gitea repo payload.');
  return { fullName: r.full_name, cloneUrl: r.clone_url, htmlUrl: r.html_url ?? r.clone_url, created };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
