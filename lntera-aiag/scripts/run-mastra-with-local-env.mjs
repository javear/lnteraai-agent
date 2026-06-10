#!/usr/bin/env node
/**
 * Run Mastra CLI with optional local `.env` merged into `process.env`.
 * For each key: if the current value is missing or only whitespace, use the file value (non-empty lines only).
 * Non-empty shell / CI exports still win over `.env`.
 *
 * Used by `npm run dev` / `npm run start` so `lntera-aiag/.env` applies without embedding dotenv in app code.
 */
import { spawn } from 'node:child_process';
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
    if (!val) continue;
    if (!process.env[key]?.trim()) {
      process.env[key] = val;
    }
  }
}

function mergeLocalEnv() {
  applyEnvFile(resolve(process.cwd(), '.env'));
  applyEnvFile(resolve(PKG_ROOT, '.env'));
}

mergeLocalEnv();

if (!process.env.DISCORD_EMBEDDED?.trim()) {
  process.env.DISCORD_EMBEDDED = '1';
}

const mastraCli = resolve(PKG_ROOT, 'node_modules/mastra/dist/index.js');
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-mastra-with-local-env.mjs <mastra-args...>');
  console.error('Example: node scripts/run-mastra-with-local-env.mjs dev');
  process.exit(1);
}

const child = spawn(process.execPath, [mastraCli, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: PKG_ROOT,
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
