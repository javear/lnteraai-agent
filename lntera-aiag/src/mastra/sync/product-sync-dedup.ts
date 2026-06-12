// Pure, best-effort dedup helpers for product-sync notifications. Two layers guard against floods:
//   1. recentlyNotified() — in-memory TTL set so webhook retries / rapid re-ingest of the SAME link
//      don't fire duplicate broadcasts within a short window (process-local; resync reconciles misses).
//   2. isDuplicateEvent() — DB-backed: the mapping row stores last_event_key, so a re-delivered
//      webhook (same signed event) is recognized and skipped.
// The link-state guard (never notify a DECIDED mapping) lives in the ingest router, which returns a
// null notice for settled links — so the notifier simply never sees them.

const NOTIFY_TTL_MS = 60_000;
const recent = new Map<string, number>();

function sweep(now: number): void {
  if (recent.size < 512) return;
  for (const [key, exp] of recent) {
    if (exp <= now) recent.delete(key);
  }
}

/** True if `key` was marked within the TTL window (and not yet expired). */
export function recentlyNotified(key: string, now = Date.now()): boolean {
  const exp = recent.get(key);
  if (exp == null) return false;
  if (exp <= now) {
    recent.delete(key);
    return false;
  }
  return true;
}

export function markNotified(key: string, now = Date.now(), ttlMs = NOTIFY_TTL_MS): void {
  sweep(now);
  recent.set(key, now + ttlMs);
}

/** A re-delivered webhook (same event key already recorded on the mapping) should not re-notify. */
export function isDuplicateEvent(
  mappingLastEventKey: string | null | undefined,
  incomingEventKey: string | null | undefined,
): boolean {
  if (!incomingEventKey) return false;
  return mappingLastEventKey === incomingEventKey;
}

/** Test seam. */
export function __resetDedupForTests(): void {
  recent.clear();
}
