import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare two strings in time independent of string content (via SHA-256 digests). */
export function constantTimeEqualString(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
