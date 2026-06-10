import { ALL_TOOLS_WILDCARD } from './types';
import { getRoleAllowedTools, getTenantUserForAuthUser } from './tenant-users';

/**
 * Resolves which tool ids a request may use, from the authenticated user's role.
 *
 * Hybrid model: tenant identity rides in the signed JWT (free), but role → tool-scope is
 * read live from the DB through a short-TTL cache — so an owner's permission change applies
 * within seconds and is revocable, without paying a DB hit on every `/api/*` call.
 *
 * Returns `'*'` (all tools) or a Set of allowed tool ids. Requests with no end-user
 * (service JWT / dev) get `'*'` — they are trusted/backend callers.
 */

const TTL_MS = 30_000;

type Allowed = '*' | Set<string>;
interface CacheEntry {
  value: Allowed;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function resolveAllowedToolIds(input: {
  tenantId?: string | null;
  authUserId?: string | null;
}): Promise<Allowed> {
  const authUserId = input.authUserId?.trim();
  if (!authUserId) return '*'; // service JWT / dev / no end-user → full access

  const key = `${input.tenantId ?? ''}:${authUserId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await computeAllowedToolIds(authUserId);
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/** Invalidate a user's cached tool-scope (call after changing their role). */
export function bustToolAccessCache(authUserId: string): void {
  const suffix = `:${authUserId}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

async function computeAllowedToolIds(authUserId: string): Promise<Allowed> {
  const membership = await getTenantUserForAuthUser(authUserId);
  if (!membership) return new Set<string>(); // not a member of any tenant → no tools

  const allowed = await getRoleAllowedTools(membership.tenantId, membership.role);
  if (allowed === null) {
    // Role row missing: owners still get everything; anyone else gets nothing.
    return membership.role === 'owner' ? '*' : new Set<string>();
  }
  if (allowed.includes(ALL_TOOLS_WILDCARD)) return '*';
  return new Set(allowed);
}
