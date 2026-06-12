// Diagnoses the Mastra Postgres connection (DATABASE_URL). Prints handshake latency + a probe query.
// Use this when the app fails to start with EAUTHTIMEOUT / SQLSTATE 08006 (slow/blocked handshake).
//   node scripts/verify-db-connect.mjs
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const envPath = resolve('.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]?.trim()) process.env[k] = v;
  }
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL not set.');
  process.exit(1);
}
const hostPort = url.replace(/^.*@/, '').replace(/\/.*$/, '');
console.log('host:port      :', hostPort);
console.log('connect timeout:', Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 30000, 'ms');

const t0 = Date.now();
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 30000,
  statement_timeout: 15000,
});
try {
  await client.connect();
  const connMs = Date.now() - t0;
  const r = await client.query('select current_database() as db, current_user as usr');
  console.log(`\n✅ connected in ${connMs}ms — db=${r.rows[0].db} user=${r.rows[0].usr}`);
  console.log(connMs > 10000 ? '⚠️ handshake >10s — a short connect timeout would EAUTHTIMEOUT here.' : 'handshake latency is healthy.');
} catch (e) {
  console.error(`\n❌ connect FAILED after ${Date.now() - t0}ms — code=${e.code ?? ''} ${e.message}`);
  console.error('   If this times out, your network/proxy is blocking or throttling the Postgres handshake.');
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
