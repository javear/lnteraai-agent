import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEdgeOneToken } from './config';

/**
 * Deploy a built site (base64 zip) to EdgeOne Pages and return the assigned public URL.
 *
 * Uses the EdgeOne CLI direct-upload (`edgeone pages deploy <zip> -n <project> -t <token>`), which
 * accepts a ZIP and auto-assigns a per-project subdomain. Requires the `edgeone` CLI on the server
 * and EDGEONE_API_TOKEN. Validate the CLI invocation + URL parsing in the Phase 0 spike.
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
    const stdout = await run('edgeone', ['pages', 'deploy', zipPath, '-n', input.projectName, '-t', token]);
    const url = extractUrl(stdout);
    if (!url) throw new Error(`Could not parse a deploy URL from EdgeOne output:\n${stdout.slice(0, 500)}`);
    return { url };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${stderr || err.message}`));
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
