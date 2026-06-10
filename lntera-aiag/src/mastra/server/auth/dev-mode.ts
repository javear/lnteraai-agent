/**
 * Local playground mode. When true, server auth is left OFF so the Mastra Studio
 * playground works locally.
 *
 * This is required, not just convenient: Studio authenticates by sending the
 * `x-mastra-dev-playground` header and relies on the framework's dev bypass, which is
 * disabled the moment ANY auth provider is configured. `MastraJwtAuth` also exposes no
 * interactive login URL, so with it attached Studio shows "Authentication Required — no
 * login method configured." Hence: auth OFF in local dev, enforced in production.
 *
 * Gated on `MASTRA_DEV` (set only by `mastra dev`, never by `mastra start`) AND
 * `NODE_ENV !== 'production'` as a belt-and-suspenders guard: even if `MASTRA_DEV` ever
 * leaks into a deployed environment, setting `NODE_ENV=production` keeps auth ON.
 */
export function isPlaygroundDevMode(): boolean {
  return process.env.MASTRA_DEV === 'true' && process.env.NODE_ENV !== 'production';
}
