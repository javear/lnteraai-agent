import { createHmac } from 'node:crypto';

const EXCLUDED_PARAMS = new Set(['sign', 'access_token']);

export interface TiktokSignInput {
  appSecret: string;
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  body?: string;
  contentType?: string;
}

/**
 * TikTok Shop signing rule:
 *   1. Drop `sign` and `access_token` from the query.
 *   2. Sort remaining params alphabetically by key.
 *   3. Concatenate: ${path}${k1}${v1}${k2}${v2}...
 *   4. If Content-Type is application/json and body is present, append the body string.
 *   5. Wrap with app_secret on both ends, then HMAC-SHA256 hex.
 */
export function signTiktok(input: TiktokSignInput): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(input.query)) {
    if (EXCLUDED_PARAMS.has(k) || v === undefined) continue;
    entries.push([k, String(v)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let base = input.path;
  for (const [k, v] of entries) base += k + v;

  if (input.body && input.contentType?.toLowerCase().includes('application/json')) {
    base += input.body;
  }

  const wrapped = input.appSecret + base + input.appSecret;
  return createHmac('sha256', input.appSecret).update(wrapped).digest('hex');
}
