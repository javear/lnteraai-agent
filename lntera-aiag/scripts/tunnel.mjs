#!/usr/bin/env node
/**
 * Expose the local Mastra server through an ngrok HTTPS tunnel so the native (Capacitor/Electron)
 * app — which needs a public backend URL — can talk to your dev machine for testing.
 *
 *   npm run tunnel              # tunnels http://localhost:4111
 *   npm run tunnel -- 3000      # or pass a port
 *
 * Requires NGROK_AUTHTOKEN in .env (free: https://dashboard.ngrok.com/get-started/your-authtoken).
 * Optional NGROK_DOMAIN gives a STABLE url (a free static domain) so you don't rebuild native each run.
 *
 * Reads .env the same way `npm run dev` does (shell/CI exports still win).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

function applyEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\r$/, '').trim();
    if (val && !process.env[key]?.trim()) process.env[key] = val;
  }
}
applyEnvFile(resolve(process.cwd(), '.env'));
applyEnvFile(resolve(PKG_ROOT, '.env'));

const port = Number(process.argv[2] || process.env.PORT || 4111);
const authtoken = process.env.NGROK_AUTHTOKEN?.trim();
const domain = process.env.NGROK_DOMAIN?.trim();

if (!authtoken) {
  console.error(
    '\n  ✗ Missing NGROK_AUTHTOKEN.\n' +
      '    1) Create a free account:  https://dashboard.ngrok.com\n' +
      '    2) Copy your authtoken:    https://dashboard.ngrok.com/get-started/your-authtoken\n' +
      '    3) Add to lntera-aiag/.env:  NGROK_AUTHTOKEN=2abc...\n',
  );
  process.exit(1);
}

const mod = await import('@ngrok/ngrok');
const ngrok = mod.default ?? mod;

const listener = await ngrok.forward({
  addr: port,
  authtoken,
  ...(domain ? { domain } : {}),
});

const url = listener.url();
console.log(
  `\n  ✓ Tunnel live\n` +
    `    ${url}  →  http://localhost:${port}\n\n` +
    `  Point the native build at it:\n` +
    `    web/.env.native →  VITE_API_BASE_URL=${url}\n` +
    `    cd web && npm run build:native && npx cap sync\n\n` +
    (domain
      ? ''
      : `  Tip: set NGROK_DOMAIN in .env for a stable URL (one free static domain per account),\n` +
        `       so the URL survives restarts and you don't rebuild native every time.\n\n`) +
    `  CORS: MASTRA_CORS_ORIGINS=* already allows the tunnel + native origins.\n` +
    `  Ctrl+C to stop.\n`,
);

// Keep the process alive until interrupted. A ref'd timer is a real libuv handle, so Node won't
// exit (an infinite top-level `await` would instead trip Node's "unsettled top-level await" exit).
const keepAlive = setInterval(() => {}, 1 << 30);

const shutdown = async () => {
  clearInterval(keepAlive);
  try {
    await listener.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
