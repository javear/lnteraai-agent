import { createHmac, timingSafeEqual } from 'node:crypto';
import { getMastraPublicBaseUrl } from '../portkey/config';

/** Gitea Cloud connection (server env). Returns null when not configured. */
export function getGiteaConfig(): { baseUrl: string; token: string; owner: string } | null {
  const baseUrl = process.env.GITEA_BASE_URL?.trim().replace(/\/+$/, '');
  const token = process.env.GITEA_TOKEN?.trim();
  const owner = process.env.GITEA_OWNER?.trim();
  if (!baseUrl || !token || !owner) return null;
  return { baseUrl, token, owner };
}

/** EdgeOne Pages deploy token (server env). */
export function getEdgeOneToken(): string | null {
  return process.env.EDGEONE_API_TOKEN?.trim() || null;
}

/** Public base URL of our API (for building the git-proxy clone URL the browser pod uses). */
export function getStudioPublicBaseUrl(): string {
  return getMastraPublicBaseUrl().replace(/\/+$/, '');
}

function proxySecret(): string {
  const s = process.env.STUDIO_PROXY_SECRET?.trim() || process.env.OAUTH_STATE_SECRET?.trim();
  if (!s) throw new Error('STUDIO_PROXY_SECRET (or OAUTH_STATE_SECRET) is not set.');
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface GitProxyClaim {
  projectId: string;
  repo: string; // "owner/name"
  exp: number; // ms epoch
}

/** Sign a short-lived, repo-scoped token embedded in the clone URL (the token never exposes creds). */
export function signGitProxyToken(claim: GitProxyClaim): string {
  const payload = b64url(JSON.stringify(claim));
  const sig = b64url(createHmac('sha256', proxySecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Verify + decode a git-proxy token; returns null if malformed, tampered, or expired. */
export function verifyGitProxyToken(token: string): GitProxyClaim | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(createHmac('sha256', proxySecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GitProxyClaim;
    if (!claim.repo || !claim.projectId || typeof claim.exp !== 'number') return null;
    if (claim.exp < Date.now()) return null;
    return claim;
  } catch {
    return null;
  }
}
