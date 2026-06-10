/**
 * CORS config for the Mastra server, driven by `MASTRA_CORS_ORIGINS`
 * (comma-separated). Set it to `*` to allow any origin.
 *
 * `*` cannot be combined with `credentials: true` (browsers reject it). We
 * authenticate with an explicit `Authorization: Bearer` header rather than
 * cookies, so credentials are unnecessary in wildcard mode and are enabled only
 * for an explicit allowlist. CORS is browser-only — the JWT is the real guard.
 */
export function getCorsConfig() {
  const origins = (process.env.MASTRA_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isWildcard = origins.includes('*');
  return {
    origin: isWildcard ? '*' : origins,
    credentials: !isWildcard,
    allowHeaders: ['Authorization', 'Content-Type', 'x-mastra-dev-playground'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  };
}
