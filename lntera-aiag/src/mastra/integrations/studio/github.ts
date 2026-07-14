import { getGithubConfig } from './config';

const API_BASE = 'https://api.github.com';

/** Derive a stable, unique external-service project name from a Studio project id — shared by every
 *  integration keyed on "the project's name elsewhere" (GitHub repo, EdgeOne project). */
export function repoNameFor(projectId: string): string {
  return `studio-${projectId.slice(0, 8)}`;
}

export interface GithubRepo {
  fullName: string; // "org/name"
  cloneUrl: string; // https clone URL on GitHub
  htmlUrl: string;
  /** True only on the actual creation path — false when an existing repo was reused (422 "exists").
   *  Callers that seed a starter template on first creation use this to avoid re-seeding (and
   *  clobbering the tenant's own work) on a later reconnect/re-init of the same project. */
  created: boolean;
}

/** REST API auth — `Bearer` + the two headers GitHub requires (User-Agent is mandatory; requests
 *  without one are rejected outright) or recommends (pinned API version). */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lntera-forge',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Git-over-HTTPS smart protocol auth is HTTP Basic (NOT the Bearer header the REST API uses) — the
 *  username is arbitrary, only the token-as-password matters. Used by the git-proxy route and
 *  template seeding, never by REST calls in this file. */
export function gitBasicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

/**
 * Create (or reuse) a private repo under the configured GitHub ORG for a Studio project. Idempotent:
 * a 422 "name already exists" falls back to fetching the existing repo.
 */
export async function createGithubRepo(name: string): Promise<GithubRepo> {
  const cfg = getGithubConfig();
  if (!cfg) throw new Error('GitHub is not configured (set GITHUB_TOKEN and GITHUB_ORG).');

  const res = await fetch(`${API_BASE}/orgs/${cfg.org}/repos`, {
    method: 'POST',
    headers: apiHeaders(cfg.token),
    body: JSON.stringify({ name, private: true, auto_init: true }),
  });

  if (res.ok) return toRepo(await res.json(), true);
  if (res.status === 422) return findOrgRepo(name);
  throw new Error(`GitHub repo create failed (${res.status}): ${await safeText(res)}`);
}

/** Find one of the org's repos by exact name (used as the idempotent reuse path). */
async function findOrgRepo(name: string): Promise<GithubRepo> {
  const cfg = getGithubConfig();
  if (!cfg) throw new Error('GitHub is not configured.');
  const res = await fetch(`${API_BASE}/repos/${cfg.org}/${name}`, { headers: apiHeaders(cfg.token) });
  if (!res.ok) throw new Error(`GitHub repo "${name}" exists but could not be located (${res.status}): ${await safeText(res)}`);
  return toRepo(await res.json(), false);
}

/** Best-effort delete — never throws. Callers use this on Forge project deletion; a GitHub-side
 *  failure (already deleted, permissions hiccup, etc.) must never block the tenant's own delete. */
export async function deleteGithubRepoBestEffort(name: string): Promise<boolean> {
  const cfg = getGithubConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(`${API_BASE}/repos/${cfg.org}/${name}`, {
      method: 'DELETE',
      headers: apiHeaders(cfg.token),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

function toRepo(json: unknown, created: boolean): GithubRepo {
  const r = json as { full_name?: string; clone_url?: string; html_url?: string };
  if (!r.full_name || !r.clone_url) throw new Error('Unexpected GitHub repo payload.');
  return { fullName: r.full_name, cloneUrl: r.clone_url, htmlUrl: r.html_url ?? r.clone_url, created };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
