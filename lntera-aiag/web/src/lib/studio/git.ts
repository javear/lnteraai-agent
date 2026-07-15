// Pure-browser git engine for Studio. Runs as plain page JavaScript (isomorphic-git against an
// IndexedDB-backed LightningFS) instead of shelling out to a `git` binary inside the BrowserPod
// sandbox. This matters because BrowserPod's own virtualized network stack only allows outbound
// requests on paid "outbound networking" tiers — but a normal page-level `fetch()` (what
// isomorphic-git's http/web client uses) is unrestricted. Only clone/fetch/push touch the network;
// everything else (status/diff/log/branch/checkout/commit) is a local IndexedDB operation.
import LightningFS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { createTwoFilesPatch } from 'diff';
import { Buffer } from 'buffer';

// isomorphic-git's browser bundle references the Node `Buffer` global directly (it isn't imported),
// so it must be shimmed once before any isomorphic-git call.
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const REPO_DIR = '/repo';
const AUTHOR = { name: 'Lntera Studio', email: 'studio@lntera.ai' };

/** Outcome of a sync attempt against the remote's current HEAD. */
export type GitSyncStatus = 'up-to-date' | 'fast-forwarded' | 'diverged' | 'uncommitted-changes';

export type GitFileStatus = 'added' | 'modified' | 'deleted';
export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}
export interface GitLogEntry {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}
export interface GitFile {
  path: string;
  content: string;
}

/** Classify one `statusMatrix` row (HEAD, WORKDIR) into a friendly status, or null if unchanged. */
function classify(head: number, workdir: number): GitFileStatus | null {
  if (head === 0 && workdir !== 0) return 'added';
  if (head === 1 && workdir === 0) return 'deleted';
  if (head === 1 && workdir === 2) return 'modified';
  return null; // unmodified (1,1) or added-then-removed-before-commit (0,0)
}

/**
 * One project's git repo, backed by a per-project IndexedDB filesystem (persists across reloads on
 * the same browser — a nice side effect of moving off the pod's ephemeral storage for git state).
 */
export class GitRepo {
  private readonly fs: LightningFS;

  constructor(storageKey: string) {
    this.fs = new LightningFS(`studio-git-${storageKey}`);
  }

  /** Whether a repo has already been cloned into this browser's IndexedDB. */
  async isCloned(): Promise<boolean> {
    try {
      await this.fs.promises.stat(`${REPO_DIR}/.git`);
      return true;
    } catch {
      return false;
    }
  }

  /** Network op: clone the proxied remote (same-origin URL — see studio.ts's git-proxy route). */
  async clone(url: string, ref?: string): Promise<void> {
    await git.clone({ fs: this.fs, http, dir: REPO_DIR, url, ref, singleBranch: true });
  }

  /** Network op: push the current branch to `origin`. Takes an explicit `url` override (the caller's
   *  freshly-signed git-proxy URL) rather than relying on `origin`'s git-config URL, which is whatever
   *  was current at this repo's ORIGINAL clone and never updated since — for a project reopened after
   *  that signed token's TTL elapses, every push then 401s even though pull/fetch (which already takes
   *  a fresh url each call, see pull() below) keeps working fine. Confirmed in production. */
  async push(url: string): Promise<void> {
    const result = await git.push({ fs: this.fs, http, dir: REPO_DIR, remote: 'origin', url });
    if (!result.ok || result.error) {
      throw new Error(`git push failed: ${result.error ?? 'unknown error'}`);
    }
  }

  /**
   * Network op: check the remote's current HEAD and fast-forward the local branch to match it, but
   * ONLY when that's unambiguously safe — never touches anything if there are uncommitted local
   * changes (would silently discard them) or if local has its own commits the remote doesn't have yet
   * (a real merge, which this deliberately doesn't attempt — same "refuse rather than guess" posture
   * as checkout()). This is what lets a browser tab pick up work pushed from elsewhere (another
   * session, another device, or a server-side fix) without needing to re-clone from scratch.
   */
  async pull(url: string, ref?: string): Promise<GitSyncStatus> {
    const branch = ref ?? (await this.currentBranch());
    if (!branch) return 'up-to-date'; // no commits/branch yet — nothing to compare against

    await git.fetch({ fs: this.fs, http, dir: REPO_DIR, url, ref: branch, singleBranch: true, tags: false });

    let localOid: string | null;
    try {
      localOid = await git.resolveRef({ fs: this.fs, dir: REPO_DIR, ref: branch });
    } catch {
      localOid = null; // local branch has no commits yet
    }
    const remoteOid = await git.resolveRef({ fs: this.fs, dir: REPO_DIR, ref: `refs/remotes/origin/${branch}` });
    if (localOid === remoteOid) return 'up-to-date';

    if ((await this.status()).length > 0) return 'uncommitted-changes';

    // Fast-forward only: remote must be strictly ahead of local (local's history is a prefix of it).
    const remoteIsAhead =
      localOid === null ||
      (await git.isDescendent({ fs: this.fs, dir: REPO_DIR, oid: remoteOid, ancestor: localOid }).catch(() => false));
    if (remoteIsAhead) {
      await git.writeRef({ fs: this.fs, dir: REPO_DIR, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
      await git.checkout({ fs: this.fs, dir: REPO_DIR, ref: branch, force: true });
      return 'fast-forwarded';
    }

    // Not remote-ahead — if LOCAL is instead the one strictly ahead (its own commits not yet pushed),
    // there's simply nothing new to pull; that's normal, not a conflict, so don't flag it as one.
    const localIsAhead =
      localOid !== null &&
      (await git.isDescendent({ fs: this.fs, dir: REPO_DIR, oid: localOid, ancestor: remoteOid }).catch(() => false));
    if (localIsAhead) return 'up-to-date';

    return 'diverged'; // both sides have commits the other lacks — a real merge, which this won't attempt
  }

  async currentBranch(): Promise<string | undefined> {
    return (await git.currentBranch({ fs: this.fs, dir: REPO_DIR, fullname: false })) ?? undefined;
  }

  async listBranches(): Promise<{ branches: string[]; current: string }> {
    const [branches, current] = await Promise.all([
      git.listBranches({ fs: this.fs, dir: REPO_DIR }),
      this.currentBranch(),
    ]);
    return { branches, current: current ?? '' };
  }

  async createBranch(name: string, opts?: { checkout?: boolean }): Promise<void> {
    await git.branch({ fs: this.fs, dir: REPO_DIR, ref: name, checkout: Boolean(opts?.checkout) });
  }

  /**
   * Switch branches/refs. Intentionally NOT forced: isomorphic-git throws a clear
   * `CheckoutConflictError` when the target would clobber uncommitted work, which is the right signal
   * for the calling agent to commit (or the human to be warned) before switching, same as real git.
   */
  async checkout(ref: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir: REPO_DIR, ref });
  }

  /** Changed files only (added/modified/deleted) — unmodified files are omitted, not just deprioritized. */
  async status(): Promise<GitStatusEntry[]> {
    const rows = await git.statusMatrix({ fs: this.fs, dir: REPO_DIR });
    const out: GitStatusEntry[] = [];
    for (const [path, head, workdir] of rows) {
      const status = classify(head, workdir);
      if (status) out.push({ path, status });
    }
    return out;
  }

  /** Unified diff (git-diff-style) of uncommitted changes, optionally scoped to one file. */
  async diff(path?: string): Promise<string> {
    const changed = (await this.status()).filter((e) => !path || e.path === path);
    if (changed.length === 0) return '';

    let headOid: string | null = null;
    try {
      headOid = await git.resolveRef({ fs: this.fs, dir: REPO_DIR, ref: 'HEAD' });
    } catch {
      headOid = null; // brand-new repo, no commits yet — every changed file is "new"
    }

    const patches: string[] = [];
    for (const entry of changed) {
      let oldContent = '';
      let newContent = '';
      try {
        if (headOid && entry.status !== 'added') {
          const { blob } = await git.readBlob({ fs: this.fs, dir: REPO_DIR, oid: headOid, filepath: entry.path });
          oldContent = Buffer.from(blob).toString('utf8');
        }
        if (entry.status !== 'deleted') {
          newContent = await this.fs.promises.readFile(`${REPO_DIR}/${entry.path}`, 'utf8');
        }
        patches.push(createTwoFilesPatch(entry.path, entry.path, oldContent, newContent, '', ''));
      } catch {
        patches.push(`diff --git a/${entry.path} b/${entry.path}\n[binary or unreadable file changed]`);
      }
    }
    return patches.join('\n');
  }

  async log(depth = 20): Promise<GitLogEntry[]> {
    try {
      const commits = await git.log({ fs: this.fs, dir: REPO_DIR, depth });
      return commits.map((c) => ({
        oid: c.oid,
        message: c.commit.message.trim(),
        author: c.commit.author.name,
        timestamp: c.commit.author.timestamp * 1000,
      }));
    } catch {
      return []; // no commits yet
    }
  }

  /** Stage all changes (add -A equivalent) and commit. Empty commits are allowed, like the old `--allow-empty`. */
  async commit(message: string): Promise<{ commit: string }> {
    const rows = await git.statusMatrix({ fs: this.fs, dir: REPO_DIR });
    for (const [path, head, workdir] of rows) {
      if (head === workdir && (head === 0 || head === 1)) continue; // unmodified or absent-absent
      if (workdir === 0) await git.remove({ fs: this.fs, dir: REPO_DIR, filepath: path });
      else await git.add({ fs: this.fs, dir: REPO_DIR, filepath: path });
    }
    const oid = await git.commit({ fs: this.fs, dir: REPO_DIR, message, author: AUTHOR, committer: AUTHOR });
    return { commit: oid };
  }

  /** Every working-tree-relative file path, skipping `.git` (cheap — no content reads). */
  async listWorkdirPaths(): Promise<string[]> {
    return this.walk('');
  }

  /** Every tracked working-tree file + its content (used to hydrate the pod after clone/checkout). */
  async listWorkdirFiles(): Promise<GitFile[]> {
    const paths = await this.walk('');
    const files: GitFile[] = [];
    for (const p of paths) {
      try {
        files.push({ path: p, content: await this.fs.promises.readFile(`${REPO_DIR}/${p}`, 'utf8') });
      } catch {
        // unreadable (e.g. binary/symlink) — skip rather than fail the whole hydrate
      }
    }
    return files;
  }

  /** Write one file into the git working tree (used by the pod->git sync before status/diff/commit). */
  async writeWorkdirFile(path: string, content: string): Promise<void> {
    const abs = `${REPO_DIR}/${path}`;
    await this.mkdirp(abs.slice(0, abs.lastIndexOf('/')));
    await this.fs.promises.writeFile(abs, content, 'utf8');
  }

  async deleteWorkdirFile(path: string): Promise<void> {
    try {
      await this.fs.promises.unlink(`${REPO_DIR}/${path}`);
    } catch {
      // already gone
    }
  }

  private async mkdirp(absDir: string): Promise<void> {
    if (!absDir || absDir === REPO_DIR) return;
    const parts = absDir.slice(REPO_DIR.length).split('/').filter(Boolean);
    let cur = REPO_DIR;
    for (const part of parts) {
      cur += `/${part}`;
      try {
        await this.fs.promises.mkdir(cur);
      } catch {
        // already exists
      }
    }
  }

  /** Recursively list working-tree-relative file paths under `rel`, skipping `.git`. */
  private async walk(rel: string): Promise<string[]> {
    const abs = rel ? `${REPO_DIR}/${rel}` : REPO_DIR;
    let names: string[];
    try {
      names = await this.fs.promises.readdir(abs);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (name === '.git') continue;
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = await this.fs.promises.stat(`${abs}/${name}`);
      if (stat.isDirectory()) out.push(...(await this.walk(relPath)));
      else out.push(relPath);
    }
    return out;
  }
}
