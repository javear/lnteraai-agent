import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEdgeOneToken } from './config';

/**
 * Deploy a built site (base64 zip) to EdgeOne Pages and return the assigned public URL.
 *
 * Uses the EdgeOne CLI direct-upload (`edgeone makers deploy <zip> -n <project> -t <token>`), which
 * accepts a ZIP and auto-assigns a per-project subdomain. Requires the `edgeone` CLI on the server
 * and EDGEONE_API_TOKEN. `makers` is the current subcommand — `pages` (used until the CLI deprecated
 * it, breaking every publish with a "pages" is deprecated" warning and a non-zero exit) is now just a
 * deprecated alias for the same thing; flags are unchanged.
 */
export async function deployToEdgeOne(input: {
  projectName: string;
  zipBase64: string;
}): Promise<{ url: string }> {
  const token = getEdgeOneToken();
  if (!token) throw new Error('EdgeOne is not configured (set EDGEONE_API_TOKEN).');

  const dir = await mkdtemp(join(tmpdir(), 'studio-deploy-'));
  const zipPath = join(dir, 'site.zip');
  try {
    await writeFile(zipPath, Buffer.from(input.zipBase64, 'base64'));
    const stdout = await runEdgeone(['makers', 'deploy', zipPath, '-n', input.projectName, '-t', token]);
    const url = extractUrl(stdout);
    if (!url) throw new Error(`Could not parse a deploy URL from EdgeOne output:\n${stdout.slice(0, 500)}`);
    return { url };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Launchers to try, in order — so the CLI runs without being a package.json dependency and without a
 * manual install: a global `edgeone` on PATH, then `bunx` (the Bun runtime image has no node/npm/npx),
 * then `npx` (local Node dev). The first launcher that actually exists is used; a "command not found"
 * (ENOENT) falls through to the next, but a real deploy failure stops immediately.
 */
const EDGEONE_LAUNCHERS: Array<[string, string[]]> = [
  ['edgeone', []],
  ['bunx', ['edgeone']],
  ['npx', ['--yes', 'edgeone']],
];

async function runEdgeone(args: string[]): Promise<string> {
  let lastError: unknown;
  for (const [cmd, prefix] of EDGEONE_LAUNCHERS) {
    try {
      return await run(cmd, [...prefix, ...args]);
    } catch (err) {
      lastError = err;
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // launcher missing → try next
      throw err; // launcher ran but the deploy failed → surface it
    }
  }
  throw new Error(
    `EdgeOne CLI unavailable (tried edgeone, bunx, npx): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Preserve ENOENT so runEdgeone can fall through to the next launcher.
        const wrapped = new Error(`${cmd} failed: ${stderr || err.message}`) as NodeJS.ErrnoException;
        wrapped.code = (err as NodeJS.ErrnoException).code;
        reject(wrapped);
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

function extractUrl(output: string): string | null {
  const m = /(https:\/\/[^\s"']+)/.exec(output);
  return m?.[1] ?? null;
}
