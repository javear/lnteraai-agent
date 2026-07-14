// Seeds a freshly-created Studio project's GitHub repo with a starter template, scoped by project
// kind, as the very first real commit — so the technical agent extends an existing, working project
// instead of scaffolding one from scratch every time (which was unreliable: no way to know in advance
// which build tools work inside the BrowserPod Wasm sandbox, and every agent had to rediscover the
// same fixes). Runs server-side, once, at project-init time, before the tenant ever opens Studio.
//
// Uses isomorphic-git against Node's own fs — not a `git` binary (the runtime image doesn't have
// one; see Dockerfile.mastra-server) and not the browser/pod (this has nothing to do with a live
// Studio session). Same library the browser-side git work already uses, just a different fs backend.
//
// Template file CONTENTS are embedded string constants (template-manifest.ts), not read from disk at
// runtime: Mastra's build only bundles statically-imported JS/TS modules, and a plain directory of
// template files under src/ does NOT survive `mastra build` (verified — it never appears in
// .mastra/output). Embedding them makes the templates genuine bundled values instead of a filesystem
// asset, so they exist wherever this module runs.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { getGithubConfig } from './config';
import { gitBasicAuthHeader } from './github';
import { WEBAPP_TEMPLATE_FILES, MCP_TEMPLATE_FILES } from './template-manifest';
import type { ProjectKind } from '../shared/types';

const AUTHOR = { name: 'Lntera Forge', email: 'forge@lntera.ai' };

function templateFilesFor(kind: ProjectKind): Record<string, string> {
  return kind === 'mcp' ? MCP_TEMPLATE_FILES : WEBAPP_TEMPLATE_FILES;
}

/**
 * Clone the repo, write the `kind`-scoped starter template over it, and push a single "Initial
 * commit" — but ONLY if the repo is still in GitHub's bare auto-init state (README only). This makes
 * the call idempotent/self-healing: it's safe to call again on every `init` (e.g. the tenant
 * reopening the project after a first attempt silently failed, such as a transient GitHub/proxy
 * timeout) without ever clobbering real content — the tenant's own commits, or a previous
 * successful seed, always short-circuit this to a no-op.
 */
export async function seedProjectTemplate(args: { kind: ProjectKind; repoFullName: string }): Promise<void> {
  const cfg = getGithubConfig();
  if (!cfg) throw new Error('GitHub is not configured.');
  const files = templateFilesFor(args.kind);
  const url = `https://github.com/${args.repoFullName}.git`;
  const headers = { Authorization: gitBasicAuthHeader(cfg.token) };

  const dir = await mkdtemp(join(tmpdir(), 'studio-seed-'));
  try {
    await git.clone({ fs, http, dir, url, headers, singleBranch: true });

    // GitHub's auto-init only ever creates a README — any other file (ours from a prior seed, or the
    // tenant's/agent's own work) means there's real content here that must not be overwritten.
    const hasRealContent = fs
      .readdirSync(dir)
      .some((name) => name !== '.git' && name.toLowerCase() !== 'readme.md');
    if (hasRealContent) return;

    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(dir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }

    const rows = await git.statusMatrix({ fs, dir });
    for (const [filepath, head, workdir] of rows) {
      if (head === workdir) continue; // unmodified
      if (workdir === 0) await git.remove({ fs, dir, filepath });
      else await git.add({ fs, dir, filepath });
    }
    await git.commit({
      fs,
      dir,
      message: 'Initial commit from Forge starter template',
      author: AUTHOR,
      committer: AUTHOR,
    });

    const result = await git.push({ fs, http, dir, url, headers, remote: 'origin' });
    if (!result.ok || result.error) throw new Error(`git push failed: ${result.error ?? 'unknown error'}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
