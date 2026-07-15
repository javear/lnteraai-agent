import { BrowserPod, type Terminal, type TextFile } from '@leaningtech/browserpod';
import { zipSync } from 'fflate';
import { GitRepo, type GitLogEntry, type GitStatusEntry, type GitSyncStatus } from './git';
import { hydratePodFromGit, syncPodToGit } from './git-sync';
import { STUDIO_RPC_TIMEOUT_MS, type StudioTreeEntry } from './protocol';

// Must fire strictly before the server's own STUDIO_RPC_TIMEOUT_MS wait on the same call — otherwise
// the two races unpredictably, and the agent sometimes sees the server's generic "Studio op timed
// out" instead of this tool's specific, more actionable "Command timed out: <command>".
const EXEC_TIMEOUT_MS = STUDIO_RPC_TIMEOUT_MS - 10_000;

/** Lifecycle of the background dev-server process (see `startDevServer`). */
export interface DevServerUpdate {
  status: 'idle' | 'starting' | 'exited';
  exitCode: number | null;
  chunk?: string;
}

/**
 * The in-browser code runtime the Studio drives. Swappable (BrowserPod today; WebContainers or a
 * remote E2B sandbox later) — the Realtime bridge listener + the UI depend only on this interface.
 */
export interface SandboxProvider {
  boot(): Promise<void>;

  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  listTree(path?: string): Promise<StudioTreeEntry[]>;
  deleteFile(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;

  exec(
    command: string,
    args?: string[],
    opts?: { cwd?: string; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /** Set the env vars (tenant-supplied secrets) every subsequent exec()/startDevServer() call gets —
   *  replaces any previous set. Local state only; takes effect on the NEXT command, not retroactively. */
  setEnv(vars: Record<string, string>): void;

  /**
   * Network op, idempotent — clones on first call; on subsequent calls (e.g. re-opening the project
   * in an already-hydrated browser), fetches and fast-forwards the local branch if the remote has
   * moved and it's safe to do so (see GitRepo.pull()). Returns 'cloned' the first time, otherwise the
   * sync outcome.
   */
  gitClone(url: string, ref?: string): Promise<'cloned' | GitSyncStatus>;
  /** Local-only: syncs the pod's current files into the git tree, then stages + commits everything. */
  gitCommit(message: string): Promise<{ commit: string }>;
  /** Network op: push the current branch. */
  gitPush(): Promise<void>;
  /** Local-only: changed files since the last commit (added/modified/deleted). */
  gitStatus(): Promise<GitStatusEntry[]>;
  /** Local-only: unified diff of uncommitted changes, optionally scoped to one file. */
  gitDiff(path?: string): Promise<string>;
  /** Local-only: recent commit history. */
  gitLog(depth?: number): Promise<GitLogEntry[]>;
  /** Local-only: list branches + the current one. */
  gitListBranches(): Promise<{ branches: string[]; current: string }>;
  /** Local-only: create a branch (optionally switching to it). */
  gitCreateBranch(name: string, opts?: { checkout?: boolean }): Promise<void>;
  /** Local-only: switch branches/refs; throws if uncommitted changes would be clobbered. */
  gitCheckout(ref: string): Promise<void>;

  /** Zip a built directory (base64) so the server deploy proxy can forward it to EdgeOne. */
  buildZip(dir: string): Promise<{ zipBase64: string }>;

  /** Public preview URL for a server running inside the sandbox (Portal), or null. */
  previewUrl(): string | null;

  /**
   * Start a long-lived background process (e.g. a dev server) on a dedicated terminal, separate
   * from exec()'s serialized worker — so it never blocks/hangs a normal command. No-op if a
   * process is already starting. Resolves once launched, NOT once it exits or is ready to serve
   * — watch onDevServerUpdate()/onPreview() for actual readiness.
   */
  startDevServer(command: string, args?: string[], opts?: { cwd?: string }): Promise<void>;
  /** Current dev-server lifecycle status ('idle' before the first start, 'exited' if it crashed/stopped). */
  devServerStatus(): { status: 'idle' | 'starting' | 'exited'; exitCode: number | null };
  /**
   * Snapshot of dev-server health + preview readiness for the agent. With `waitSeconds`, polls until
   * the preview URL is live, the dev server exits, or the wait elapses — whichever comes first.
   */
  checkPreview(waitSeconds?: number): Promise<{
    devServer: 'idle' | 'starting' | 'exited';
    exitCode: number | null;
    previewReady: boolean;
    outputTail: string;
  }>;
  /** Notified on every dev-server status change and output chunk. */
  onDevServerUpdate(cb: (update: DevServerUpdate) => void): () => void;

  /** Subscribe to ALL command output (for the terminal UI). Returns an unsubscribe fn. */
  subscribeOutput(cb: (chunk: string) => void): () => void;
  /** Notified when the preview (Portal) URL becomes available or changes. */
  onPreview(cb: (url: string) => void): () => void;

  dispose(): Promise<void>;
}

/** Project working directory inside the pod. */
const WORKDIR = '/project';
/** Marker printed after each command so we can recover the exit code from a thin, opaque API. */
const SENTINEL = '__BP_EXIT__';
const SENTINEL_RE = new RegExp(`${SENTINEL}(-?\\d+)\\s*$`, 'm');

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * BrowserPod-backed provider.
 *
 * NOTE: the BrowserPod SDK is intentionally thin — `run()` streams to a Terminal and `Process` is
 * opaque (no exit code), and there is no `readdir`. So we: capture command output through one hidden
 * "worker" terminal, recover the exit code via a `printf __BP_EXIT__$?` sentinel, and list files with
 * a small `node` walker. These conventions should be re-validated in the Phase 0 spike.
 */
export class BrowserPodProvider implements SandboxProvider {
  private pod: BrowserPod | null = null;
  private worker: Terminal | null = null;
  private preview: string | null = null;
  private readonly outputSubs = new Set<(chunk: string) => void>();
  private readonly previewSubs = new Set<(url: string) => void>();
  // Git runs entirely outside the pod (plain page JS against IndexedDB) — see git.ts for why.
  private readonly git: GitRepo;
  // The signed git-proxy URL is short-lived (see signGitProxyToken/GIT_PROXY_TTL_MS server-side) and
  // gitClone() always receives a FRESH one on every boot — but push() has no url parameter of its own
  // and, unless given one explicitly, isomorphic-git falls back to whatever remote URL is stored in
  // this repo's git config from its ORIGINAL clone. For a project reopened well after that token
  // expired, every push then fails with a 401 that looks identical to a real auth problem (confirmed
  // in production: a 9-day-old project's push failed twice this way, while pull/fetch — which DOES
  // take a fresh url each call — kept working fine the whole time). Track the latest clone/pull URL
  // here so push() can reuse it instead of the stale stored one.
  private lastGitUrl: string | null = null;

  // Tenant-supplied secrets (see setEnv), threaded into every exec()/startDevServer() call's `env`.
  private envVars: Record<string, string> = {};

  // Dev server: a SEPARATE terminal from `worker` because it never exits — running it on the
  // shared worker would permanently wedge exec()'s serialized sentinel-based completion tracking.
  private devTerminal: Terminal | null = null;
  private devState: { status: 'idle' | 'starting' | 'exited'; exitCode: number | null } = {
    status: 'idle',
    exitCode: null,
  };
  private devTailBuf = '';
  // Rolling tail of dev-server output for checkPreview reporting (compile errors live here). Kept
  // separate from devTailBuf, whose short window exists only for sentinel-boundary detection.
  private devOutputTail = '';
  private readonly devSubs = new Set<(update: DevServerUpdate) => void>();

  // Serialize exec (single worker terminal) + track the in-flight capture.
  private execChain: Promise<unknown> = Promise.resolve();
  private active: {
    buf: string;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    resolve: (r: { exitCode: number; stdout: string; stderr: string }) => void;
  } | null = null;

  constructor(private readonly opts: { apiKey?: string; nodeVersion?: string; storageKey?: string } = {}) {
    this.git = new GitRepo(opts.storageKey ?? 'default');
  }

  async boot(): Promise<void> {
    if (this.pod) return;
    const apiKey = this.opts.apiKey ?? (import.meta.env.VITE_BROWSERPOD_KEY as string | undefined);
    if (!apiKey) throw new Error('VITE_BROWSERPOD_KEY is not set — cannot boot the sandbox.');

    const pod = await BrowserPod.boot({
      apiKey,
      ...(this.opts.nodeVersion ? { nodeVersion: this.opts.nodeVersion } : {}),
      ...(this.opts.storageKey ? { storageKey: this.opts.storageKey } : {}),
    });
    pod.onPortal(({ url }) => {
      this.preview = url;
      for (const cb of this.previewSubs) cb(url);
    });

    const decoder = new TextDecoder();
    this.worker = await pod.createCustomTerminal({
      cols: 120,
      rows: 40,
      onOutput: (buffer: ArrayBuffer) => {
        // When the page is cross-origin isolated, BrowserPod hands us a SharedArrayBuffer-backed
        // view, which TextDecoder.decode() rejects ("must not be shared"). Copy into a plain
        // (non-shared) Uint8Array first.
        const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        const text = decoder.decode(copy);
        for (const cb of this.outputSubs) cb(text);
        const a = this.active;
        if (!a) return;
        a.buf += text;
        // Forward everything except the sentinel line to the per-exec stream.
        a.onOutput?.(text.replace(SENTINEL_RE, ''), 'stdout');
        const m = SENTINEL_RE.exec(a.buf);
        if (m) {
          const exitCode = Number(m[1]);
          const stdout = a.buf.replace(SENTINEL_RE, '').replace(/\n$/, '');
          this.active = null;
          a.resolve({ exitCode, stdout, stderr: '' });
        }
      },
    });

    this.pod = pod;
    await this.mkdir(WORKDIR);
  }

  private podOrThrow(): BrowserPod {
    if (!this.pod || !this.worker) throw new Error('Sandbox not booted.');
    return this.pod;
  }

  setEnv(vars: Record<string, string>): void {
    this.envVars = vars;
  }

  /** `KEY=VALUE` strings for BrowserPod's `run()` `env` option, from the currently-set secrets. */
  private envArgs(): string[] {
    return Object.entries(this.envVars).map(([k, v]) => `${k}=${v}`);
  }

  subscribeOutput(cb: (chunk: string) => void): () => void {
    this.outputSubs.add(cb);
    return () => this.outputSubs.delete(cb);
  }
  onPreview(cb: (url: string) => void): () => void {
    this.previewSubs.add(cb);
    if (this.preview) cb(this.preview);
    return () => this.previewSubs.delete(cb);
  }
  previewUrl(): string | null {
    return this.preview;
  }

  devServerStatus(): { status: 'idle' | 'starting' | 'exited'; exitCode: number | null } {
    return this.devState;
  }
  onDevServerUpdate(cb: (update: DevServerUpdate) => void): () => void {
    this.devSubs.add(cb);
    return () => this.devSubs.delete(cb);
  }
  private setDevState(patch: Partial<{ status: 'idle' | 'starting' | 'exited'; exitCode: number | null }>, chunk?: string): void {
    this.devState = { ...this.devState, ...patch };
    const update: DevServerUpdate = { ...this.devState, ...(chunk !== undefined ? { chunk } : {}) };
    for (const cb of this.devSubs) cb(update);
  }

  async startDevServer(command: string, args: string[] = [], opts?: { cwd?: string }): Promise<void> {
    if (this.devState.status === 'starting') return;
    const pod = this.podOrThrow();

    if (!this.devTerminal) {
      const decoder = new TextDecoder();
      this.devTerminal = await pod.createCustomTerminal({
        cols: 120,
        rows: 40,
        onOutput: (buffer: ArrayBuffer) => {
          const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
          const copy = new Uint8Array(view.byteLength);
          copy.set(view);
          const text = decoder.decode(copy);
          this.devOutputTail = (this.devOutputTail + text).slice(-4000);
          // Keep only a short tail for sentinel-boundary detection — the process runs indefinitely,
          // so accumulating full output here (like exec()'s `a.buf`) would leak memory over a session.
          this.devTailBuf = (this.devTailBuf + text).slice(-200);
          const m = SENTINEL_RE.exec(this.devTailBuf);
          if (m) {
            this.devTailBuf = '';
            this.setDevState({ status: 'exited', exitCode: Number(m[1]) }, text.replace(SENTINEL_RE, ''));
            return;
          }
          this.setDevState({}, text);
        },
      });
    }

    const cwd = this.abs(opts?.cwd ?? '.');
    const line = [command, ...args].map(shellQuote).join(' ');
    const env = 'export CI=true npm_config_yes=true npm_config_fund=false npm_config_audit=false;';
    const script = `${env} cd ${shellQuote(cwd)} 2>/dev/null; ${line} < /dev/null 2>&1; printf '\\n${SENTINEL}%s\\n' "$?"`;

    this.devTailBuf = '';
    this.devOutputTail = '';
    this.setDevState({ status: 'starting', exitCode: null });
    try {
      const started = pod.run('bash', ['-lc', script], { terminal: this.devTerminal, echo: false, env: this.envArgs() }) as unknown;
      if (started && typeof (started as { catch?: unknown }).catch === 'function') {
        (started as Promise<unknown>).catch((err) => {
          this.setDevState({ status: 'exited', exitCode: -1 }, err instanceof Error ? err.message : String(err));
        });
      }
    } catch (err) {
      this.setDevState({ status: 'exited', exitCode: -1 }, err instanceof Error ? err.message : String(err));
    }
  }

  async checkPreview(waitSeconds?: number): Promise<{
    devServer: 'idle' | 'starting' | 'exited';
    exitCode: number | null;
    previewReady: boolean;
    outputTail: string;
  }> {
    const snapshot = () => ({
      devServer: this.devState.status,
      exitCode: this.devState.exitCode,
      previewReady: this.preview !== null,
      outputTail: this.devOutputTail.replace(SENTINEL_RE, ''),
    });
    const deadline = Date.now() + Math.max(0, waitSeconds ?? 0) * 1000;
    // Poll rather than subscribe: the terminal states we wait for (preview up / server exited) are
    // both plain fields, and a 500ms cadence is far below the caller's own RPC timeout resolution.
    while (Date.now() < deadline) {
      if (this.preview !== null || this.devState.status === 'exited') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return snapshot();
  }

  async writeFile(path: string, content: string): Promise<void> {
    const pod = this.podOrThrow();
    const abs = this.abs(path);
    const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
    await pod.createDirectory(dir, { recursive: true });
    // BrowserPod file modes are "utf-8" (text → TextFile) / "binary" (→ BinaryFile), NOT posix r/w.
    const file = (await pod.createFile(abs, 'utf-8')) as TextFile;
    await file.write(content);
    await file.close();
  }

  async readFile(path: string): Promise<string> {
    const pod = this.podOrThrow();
    const file = (await pod.openFile(this.abs(path), 'utf-8')) as TextFile;
    try {
      const size = await file.getSize();
      return await file.read(size);
    } finally {
      await file.close();
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.podOrThrow().createDirectory(this.abs(path), { recursive: true });
  }

  async deleteFile(path: string): Promise<void> {
    await this.exec('rm', ['-rf', this.abs(path)]);
  }

  async listTree(path?: string): Promise<StudioTreeEntry[]> {
    const base = this.abs(path ?? '.');
    // Node walker → JSON, printed after a unique marker (not just "the last line") — confirmed live
    // that BrowserPod's `node` invocations can emit their own extra line (e.g. a startup banner like
    // "Node.js v22.15.0") alongside our script's output, which broke the previous "last line is our
    // JSON" assumption deterministically. Scanning for our marker is immune to whatever BrowserPod
    // prints before or after it.
    const marker = '__STUDIO_TREE_JSON__';
    const script = `const fs=require('fs'),p=require('path');const base=${JSON.stringify(base)};const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='.git'||e.name==='node_modules')continue;const fp=p.join(d,e.name);const rel=p.relative(${JSON.stringify(WORKDIR)},fp);if(e.isDirectory()){out.push({path:rel,type:'dir'});walk(fp);}else{out.push({path:rel,type:'file'});}}}try{walk(base);}catch(e){}console.log(${JSON.stringify(marker)}+JSON.stringify(out));`;

    // BrowserPod's own launcher doesn't handle `node -e <script>` — confirmed live: it errors trying
    // to require('-e') as a MODULE rather than recognizing Node's inline-eval flag at all (an error
    // straight out of BrowserPod's own bpworker.js, not our script or real Node). Side-step the flag
    // entirely: write the script to a real file (outside the project's own workdir, so it never
    // shows up in the listing it produces) and run that — the most standard invocation there is.
    const scriptPath = '/tmp/.studio-list-tree.js';
    await this.writeFile(scriptPath, script);
    const { stdout } = await this.exec('node', [scriptPath]);
    const lines = stdout.trim().split('\n');
    const markedLine = [...lines].reverse().find((l) => l.startsWith(marker));
    if (markedLine === undefined) {
      throw new Error(`Failed to list project files — no output found from the sandbox (got: ${stdout.slice(0, 200)})`);
    }
    try {
      return JSON.parse(markedLine.slice(marker.length)) as StudioTreeEntry[];
    } catch (err) {
      // A genuine "no files" result is valid JSON ('[]') and never reaches this catch. Reaching here
      // means our OWN marked line failed to parse — a real problem, not "the project is empty".
      // syncPodToGit() treats an empty listTree() result as authoritative and will delete every
      // git-tracked file to match it (confirmed live to have wiped a real project), so this must
      // surface as a real error rather than being masked as emptiness.
      throw new Error(
        `Failed to list project files — unexpected output from the sandbox: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  exec(
    command: string,
    args: string[] = [],
    opts?: { cwd?: string; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const run = () => this.execNow(command, args, opts);
    const p = this.execChain.then(run, run);
    this.execChain = p.catch(() => undefined);
    return p;
  }

  private execNow(
    command: string,
    args: string[],
    opts?: { cwd?: string; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const pod = this.podOrThrow();
    const cwd = this.abs(opts?.cwd ?? '.');
    const line = [command, ...args].map(shellQuote).join(' ');
    // No human is ever attached to this terminal (the agent runs it, the UI only displays output), so
    // an interactive prompt (npm/npx's "Ok to proceed? (y)", any raw `read`) would just hang until the
    // timeout. CI=true + npm's yes config make well-behaved tools skip prompting; `< /dev/null` is the
    // backstop for anything that still tries to read stdin — it gets an immediate EOF instead of a hang.
    const env = 'export CI=true npm_config_yes=true npm_config_fund=false npm_config_audit=false;';
    const script = `${env} cd ${shellQuote(cwd)} 2>/dev/null; ${line} < /dev/null 2>&1; printf '\\n${SENTINEL}%s\\n' "$?"`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.active) this.active = null;
        reject(new Error(`Command timed out: ${command}`));
      }, EXEC_TIMEOUT_MS);
      this.active = {
        buf: '',
        onOutput: opts?.onOutput,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const failStart = (err: unknown) => {
        clearTimeout(timer);
        this.active = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      // BrowserPod's run() returns a Process synchronously (despite the Promise<Process> typing), so
      // we can't .catch() it — completion is detected via the sentinel in onOutput. Guard for both a
      // sync return and a possible thenable, and catch a synchronous start failure.
      try {
        const started = pod.run('bash', ['-lc', script], { terminal: this.worker!, echo: false, env: this.envArgs() }) as unknown;
        if (started && typeof (started as { catch?: unknown }).catch === 'function') {
          (started as Promise<unknown>).catch(failStart);
        }
      } catch (err) {
        failStart(err);
      }
    });
  }

  async gitClone(url: string, ref?: string): Promise<'cloned' | GitSyncStatus> {
    this.lastGitUrl = url;
    let result: 'cloned' | GitSyncStatus;
    if (!(await this.git.isCloned())) {
      await this.git.clone(url, ref);
      result = 'cloned';
    } else {
      result = await this.git.pull(url, ref);
    }
    // The pod is a brand-new WASM instance every boot — only git's IndexedDB state persists across
    // reloads — so it always needs re-hydrating from whatever git ends up holding, sync or no sync.
    await hydratePodFromGit(this, this.git);
    return result;
  }

  async gitCommit(message: string): Promise<{ commit: string }> {
    await syncPodToGit(this, this.git);
    return this.git.commit(message);
  }

  async gitPush(): Promise<void> {
    if (!this.lastGitUrl) throw new Error('No git remote yet — open/sync the project before pushing.');
    await this.git.push(this.lastGitUrl);
  }

  async gitStatus(): Promise<GitStatusEntry[]> {
    await syncPodToGit(this, this.git);
    return this.git.status();
  }

  async gitDiff(path?: string): Promise<string> {
    await syncPodToGit(this, this.git);
    return this.git.diff(path);
  }

  async gitLog(depth?: number): Promise<GitLogEntry[]> {
    return this.git.log(depth);
  }

  async gitListBranches(): Promise<{ branches: string[]; current: string }> {
    return this.git.listBranches();
  }

  async gitCreateBranch(name: string, opts?: { checkout?: boolean }): Promise<void> {
    await this.git.createBranch(name, opts);
  }

  async gitCheckout(ref: string): Promise<void> {
    await syncPodToGit(this, this.git); // surfaces uncommitted pod edits before isomorphic-git's conflict check
    await this.git.checkout(ref);
    await hydratePodFromGit(this, this.git);
  }

  async buildZip(dir: string): Promise<{ zipBase64: string }> {
    const pod = this.podOrThrow();
    const entries = await this.listTree(dir);
    const files: Record<string, Uint8Array> = {};
    const prefix = dir.replace(/^\.?\/?/, '').replace(/\/$/, '');
    for (const e of entries) {
      if (e.type !== 'file') continue;
      // e.path is relative to WORKDIR; strip the built-dir prefix so the zip root is the dir itself.
      const rel = prefix && e.path.startsWith(`${prefix}/`) ? e.path.slice(prefix.length + 1) : e.path;
      const bin = await pod.openFile(this.abs(e.path), 'binary');
      try {
        const size = await bin.getSize();
        const buf = await (bin as unknown as { read: (n: number) => Promise<ArrayBuffer> }).read(size);
        files[rel] = new Uint8Array(buf);
      } finally {
        await bin.close();
      }
    }
    const zipped = zipSync(files);
    return { zipBase64: base64FromBytes(zipped) };
  }

  async dispose(): Promise<void> {
    this.outputSubs.clear();
    this.previewSubs.clear();
    this.devSubs.clear();
    this.active = null;
    this.pod = null;
    this.worker = null;
    this.devTerminal = null;
    this.devState = { status: 'idle', exitCode: null };
  }

  /** Resolve a project-relative path against the workdir (absolute paths pass through). */
  private abs(path: string): string {
    if (path.startsWith('/')) return path;
    const clean = path.replace(/^\.\//, '');
    return clean === '.' || clean === '' ? WORKDIR : `${WORKDIR}/${clean}`;
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
