// Keeps the pod's execution filesystem (Node/npm/build/preview) and the git working tree
// (IndexedDB, see git.ts) in agreement. Two directions:
//  - hydrate: git -> pod, after clone/checkout (the pod needs the files to run/build them).
//  - sync: pod -> git, before status/diff/commit (picks up both agent edits AND exec-generated
//    files like a lockfile from `npm install`, which only ever exist in the pod).
// Both are pure local file I/O (pod reads are WASM fs reads, git reads are IndexedDB reads) — no
// network involved, so this has nothing to do with BrowserPod's outbound-network restriction.
import ignore from 'ignore';
import type { GitRepo } from './git';
import type { SandboxProvider } from './sandbox';

/** Noise no Studio project should ever commit, regardless of an explicit .gitignore. */
const ALWAYS_IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.next', '.vercel'];

async function loadIgnoreMatcher(provider: SandboxProvider) {
  const ig = ignore().add(ALWAYS_IGNORE);
  try {
    const gitignore = await provider.readFile('.gitignore');
    ig.add(gitignore.split('\n'));
  } catch {
    // no .gitignore — the ALWAYS_IGNORE defaults still apply
  }
  return ig;
}

/** Write every git-tracked file into the pod, and remove pod files that are no longer tracked (branch switch). */
export async function hydratePodFromGit(provider: SandboxProvider, git: GitRepo): Promise<void> {
  const files = await git.listWorkdirFiles();
  const trackedPaths = new Set(files.map((f) => f.path));

  for (const f of files) await provider.writeFile(f.path, f.content);

  const existing = await provider.listTree();
  const ig = ignore().add(ALWAYS_IGNORE);
  for (const entry of existing) {
    if (entry.type !== 'file') continue;
    if (ig.ignores(entry.path)) continue; // never touch node_modules/dist/etc.
    if (!trackedPaths.has(entry.path)) await provider.deleteFile(entry.path);
  }
}

/** Mirror the pod's current tree into the git working tree, so status/diff/commit see live pod state. */
export async function syncPodToGit(provider: SandboxProvider, git: GitRepo): Promise<void> {
  const ig = await loadIgnoreMatcher(provider);
  const entries = await provider.listTree();
  const podFiles = entries.filter((e) => e.type === 'file' && !ig.ignores(e.path));
  const podPaths = new Set(podFiles.map((e) => e.path));

  const gitPaths = await git.listWorkdirPaths();
  // Refuse a sync that would delete every file git already tracks in one shot. listTree() now
  // throws on a genuine read failure (see sandbox.ts) rather than masking it as "no files", so
  // reaching here with zero pod files while git has real tracked ones is exactly the scenario that
  // let a real commit land with git's canonical empty-tree hash, wiping an entire project, live.
  // Fail loudly instead so the agent/user sees a real error and can retry, rather than silently
  // committing the deletion of everything.
  if (gitPaths.length > 0 && podFiles.length === 0) {
    throw new Error(
      "The sandbox reported no files at all, but git has tracked files from before — refusing to sync (this would delete everything). Try again.",
    );
  }

  for (const entry of podFiles) {
    const content = await provider.readFile(entry.path);
    await git.writeWorkdirFile(entry.path, content);
  }

  for (const p of gitPaths) {
    if (!podPaths.has(p)) await git.deleteWorkdirFile(p);
  }
}
