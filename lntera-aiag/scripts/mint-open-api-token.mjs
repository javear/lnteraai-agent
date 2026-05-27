#!/usr/bin/env node
/**
 * Mint an Open API JWT: POST {OPENAPI_BASE_URL}/svc/v1/auth/token
 *
 * Requires the server to have OPENAPI_JWT_SECRET + OPENAPI_SERVICE_API_KEY set (same as your .env when running mastra dev).
 *
 * Usage (from anywhere; loads lntera-aiag/.env next to this script):
 *   node path/to/scripts/mint-open-api-token.mjs <tenantId> [ttl_seconds]
 *   TENANT_ID=default node path/to/scripts/mint-open-api-token.mjs
 *   TENANT_ID=default TTL_SECONDS=300 node path/to/scripts/mint-open-api-token.mjs
 *
 * Env (client / this script):
 *   OPENAPI_SERVICE_API_KEY — must match the server's key (header X-Service-Api-Key)
 *   OPENAPI_BASE_URL — default http://localhost:4111
 *   TENANT_ID — tenant UUID or slug if not passed as first argument
 *   TTL_SECONDS — optional lifetime (seconds) if not passed as second argument
 *
 * Server-side token lifetime (not set by this script — only the server reads this when minting):
 *   OPENAPI_JWT_TTL_SECONDS — default and max TTL in seconds (default 900). Request ttl_seconds is clamped to this.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** lntera-aiag/ (parent of scripts/) */
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
    if (!val) continue;
    // Treat empty string as unset so `.env` can fill (shell `export FOO=` no longer blocks file).
    if (!process.env[key]?.trim()) {
      process.env[key] = val;
    }
  }
}

function loadDotEnv() {
  // Prefer cwd .env first, then package .env fills missing keys (so wrong cwd still picks up lntera-aiag/.env).
  applyEnvFile(resolve(process.cwd(), '.env'));
  applyEnvFile(resolve(PKG_ROOT, '.env'));
}

loadDotEnv();

const base = (process.env.OPENAPI_BASE_URL ?? 'http://localhost:4111').replace(/\/$/, '');
const serviceKey = process.env.OPENAPI_SERVICE_API_KEY?.trim();
const tenantId = (process.argv[2] ?? process.env.TENANT_ID)?.trim();
const ttlFromArg = process.argv[3]?.trim();
const ttlFromEnv = process.env.TTL_SECONDS?.trim();
const ttlSecondsParsed = ttlFromArg ?? ttlFromEnv;
let ttl_seconds;
if (ttlSecondsParsed !== undefined && ttlSecondsParsed !== '') {
  const n = Number.parseInt(ttlSecondsParsed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error('ttl_seconds must be a positive integer (argv[3] or TTL_SECONDS env)');
    process.exit(1);
  }
  ttl_seconds = n;
}

if (!serviceKey) {
  console.error('Missing OPENAPI_SERVICE_API_KEY.');
  console.error(`  Tried: ${resolve(process.cwd(), '.env')} and ${resolve(PKG_ROOT, '.env')}`);
  console.error('  Set it in lntera-aiag/.env (same value the Mastra server uses), then retry.');
  process.exit(1);
}
if (!tenantId) {
  console.error('Usage: node scripts/mint-open-api-token.mjs <tenantId> [ttl_seconds]\n   or set TENANT_ID (and optional TTL_SECONDS) in .env');
  process.exit(1);
}

const url = `${base}/svc/v1/auth/token`;
const payload = { tenantId };
if (ttl_seconds !== undefined) payload.ttl_seconds = ttl_seconds;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Service-Api-Key': serviceKey,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (res.status === 401 && body?.error?.code === 'unauthorized') {
    console.error('\nHint: OPENAPI_SERVICE_API_KEY must match the running server exactly.');
    console.error('  Add it to lntera-aiag/.env, restart `npm run dev`, and run this script again.');
  }
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
