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
  /** 'production' (default) is the tenant's stable, Publish-triggered URL; 'preview' is a separate,
   *  persistent URL the agent redeploys to on its own — the same project, two live environments. */
  env?: 'production' | 'preview';
}): Promise<{ url: string }> {
  const token = getEdgeOneToken();
  if (!token) throw new Error('EdgeOne is not configured (set EDGEONE_API_TOKEN).');

  const dir = await mkdtemp(join(tmpdir(), 'studio-deploy-'));
  const zipPath = join(dir, 'site.zip');
  try {
    await writeFile(zipPath, Buffer.from(input.zipBase64, 'base64'));
    // The CLI writes its own config/cache under a `.edgeone` dir it derives from cwd/$HOME — neither
    // of which we can assume is writable (the runtime container runs as a non-root user with no home
    // dir set, and its cwd/WORKDIR is owned by root: EACCES mkdir'ing '/app/.edgeone' in production).
    // Point both at our own tmp dir, which we just created and know is writable.
    const stdout = await runEdgeone(
      ['makers', 'deploy', zipPath, '-n', input.projectName, '-e', input.env ?? 'production', '-t', token],
      { redact: [token], cwd: dir },
    );
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

async function runEdgeone(args: string[], opts: { redact?: string[]; cwd?: string } = {}): Promise<string> {
  let lastError: unknown;
  for (const [cmd, prefix] of EDGEONE_LAUNCHERS) {
    try {
      return await run(cmd, [...prefix, ...args], opts);
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

/** Strip secret values (e.g. the API token, which rides in argv) out of a string before it's ever thrown/logged. */
function redactSecrets(text: string, redact: string[]): string {
  let out = text;
  for (const secret of redact) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** The CLI colors its output for a terminal — strip the ANSI codes before this ever reaches a toast. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function run(cmd: string, args: string[], opts: { redact?: string[]; cwd?: string } = {}): Promise<string> {
  const redact = opts.redact ?? [];
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        ...(opts.cwd ? { cwd: opts.cwd, env: { ...process.env, HOME: opts.cwd } } : {}),
      },
      (err, rawStdout, rawStderr) => {
        const stdout = stripAnsi(rawStdout);
        const stderr = stripAnsi(rawStderr);
        if (err) {
          // Preserve ENOENT so runEdgeone can fall through to the next launcher.
          //
          // The CLI writes its actual, useful failure reason to STDOUT (confirmed directly — its
          // colored [cli][✘] lines are stdout, not stderr), so preferring stderr alone silently
          // discarded it and left only Node's generic "Command failed: <full argv>" — which, worse,
          // embeds the token we passed via `-t` in plain text. Prefer real CLI output; redact secrets
          // from whatever we end up using either way, since the argv fallback can still leak it.
          const detail = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || err.message;
          const wrapped = new Error(`${cmd} failed: ${redactSecrets(detail, redact)}`) as NodeJS.ErrnoException;
          wrapped.code = (err as NodeJS.ErrnoException).code;
          reject(wrapped);
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

function extractUrl(output: string): string | null {
  const m = /(https:\/\/[^\s"']+)/.exec(output);
  return m?.[1] ?? null;
}
