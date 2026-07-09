import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare two strings in time independent of string content (via SHA-256 digests). */
export function constantTimeEqualString(a: string, b: string): boolean {
  // Not password storage — node:crypto's timingSafeEqual requires equal-length buffers, so both
  // secrets are hashed only to normalize length before the constant-time comparison below. A
  // slow/adaptive hash (bcrypt/argon2) would be the wrong tool here: there's no stored hash to
  // protect against offline brute force, just two fresh in-memory values compared once per request.
  // codeql[js/insufficient-password-hash]
  const da = createHash('sha256').update(a, 'utf8').digest();
  // codeql[js/insufficient-password-hash]
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
