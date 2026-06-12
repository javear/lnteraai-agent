// Verifies the platform embedding route (Portkey gateway -> OpenRouter Qwen3) using the same
// inference key + model-catalog string the app uses. Prints only non-secret diagnostics.
//   node scripts/verify-embedding.mjs
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const base = (process.env.PORTKEY_BASE_URL?.trim() || 'https://api.portkey.ai/v1').replace(/\/+$/, '');
const model = process.env.PORTKEY_EMBEDDING_MODEL?.trim();
const key = process.env.PORTKEY_API_KEY?.trim();
const vk = process.env.PORTKEY_EMBEDDING_VIRTUAL_KEY?.trim();

console.log('base url            :', base);
console.log('PORTKEY_EMBEDDING_MODEL:', model ? model : '(NOT SET)');
console.log('PORTKEY_API_KEY     :', key ? 'set' : '(NOT SET)');
console.log('virtual key (deprecated):', vk ? 'set' : 'not set (good)');
if (!model || !key) {
  console.error('\nMissing PORTKEY_EMBEDDING_MODEL or PORTKEY_API_KEY in .env');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'x-portkey-api-key': key };
if (vk) headers['x-portkey-virtual-key'] = vk;

const dimensions = Number(process.env.PORTKEY_EMBEDDING_DIMENSIONS) || 2560;
console.log('requested dimensions:', dimensions);

const res = await fetch(`${base}/embeddings`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model, input: ['panadol extra 500mg tablet, box of 12'], dimensions }),
});
const text = await res.text();
console.log('\nHTTP status         :', res.status);
if (!res.ok) {
  console.error('error body          :', text.slice(0, 600));
  process.exit(1);
}
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error('response not JSON   :', text.slice(0, 300));
  process.exit(1);
}
const emb = json?.data?.[0]?.embedding;
console.log('returned model      :', json?.model ?? '(unknown)');
console.log('embedding length    :', Array.isArray(emb) ? emb.length : '(none)');
const expected = dimensions;
console.log(Array.isArray(emb) && emb.length === expected ? `\nOK — ${expected}-d, matches halfvec(${expected}).` : `\n⚠️ dimension != ${expected} — check PORTKEY_EMBEDDING_MODEL / PORTKEY_EMBEDDING_DIMENSIONS.`);
