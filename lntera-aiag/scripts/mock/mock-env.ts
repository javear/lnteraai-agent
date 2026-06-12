// Loads lntera-aiag/.env into process.env BEFORE any pipeline module is imported (several modules,
// e.g. qwen-embeddings, read env at module-eval time). The mock entrypoints call this, then
// dynamic-import the real pipeline.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadLocalEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, '../../.env'); // scripts/mock → repo root
  if (!existsSync(envPath)) {
    console.warn(`[mock] no .env found at ${envPath} — relying on the ambient environment.`);
    return;
  }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v: string | undefined | null): v is string {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}
