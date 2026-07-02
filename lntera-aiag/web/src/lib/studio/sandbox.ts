import { BrowserPod, type Terminal, type TextFile } from '@leaningtech/browserpod';
import { zipSync } from 'fflate';
import type { StudioTreeEntry } from './protocol';

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

  gitClone(url: string, ref?: string): Promise<void>;
  gitCommit(message: string): Promise<{ commit: string }>;
  gitPush(): Promise<void>;

  /** Zip a built directory (base64) so the server deploy proxy can forward it to EdgeOne. */
  buildZip(dir: string): Promise<{ zipBase64: string }>;

  /** Public preview URL for a server running inside the sandbox (Portal), or null. */
  previewUrl(): string | null;

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

  // Serialize exec (single worker terminal) + track the in-flight capture.
  private execChain: Promise<unknown> = Promise.resolve();
  private active: {
    buf: string;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    resolve: (r: { exitCode: number; stdout: string; stderr: string }) => void;
  } | null = null;

  constructor(private readonly opts: { apiKey?: string; nodeVersion?: string; storageKey?: string } = {}) {}

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

  async writeFile(path: string, content: string): Promise<void> {
    const pod = this.podOrThrow();
    const abs = this.abs(path);
    const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
    await pod.createDirectory(dir, { recursive: true });
    const file = (await pod.createFile(abs, 'w')) as TextFile;
    await file.write(content);
    await file.close();
  }

  async readFile(path: string): Promise<string> {
    const pod = this.podOrThrow();
    const file = (await pod.openFile(this.abs(path), 'r')) as TextFile;
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
    // Node walker → JSON. Robust across the pod's coreutils and yields file/dir types + rel paths.
    const script = `const fs=require('fs'),p=require('path');const base=${JSON.stringify(base)};const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='.git'||e.name==='node_modules')continue;const fp=p.join(d,e.name);const rel=p.relative(${JSON.stringify(WORKDIR)},fp);if(e.isDirectory()){out.push({path:rel,type:'dir'});walk(fp);}else{out.push({path:rel,type:'file'});}}}try{walk(base);}catch(e){}console.log(JSON.stringify(out));`;
    const { stdout } = await this.exec('node', ['-e', script]);
    const lines = stdout.trim().split('\n');
    const jsonLine = lines[lines.length - 1] ?? '[]';
    try {
      return JSON.parse(jsonLine) as StudioTreeEntry[];
    } catch {
      return [];
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
    const script = `cd ${shellQuote(cwd)} 2>/dev/null; ${line} 2>&1; printf '\\n${SENTINEL}%s\\n' "$?"`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.active) this.active = null;
        reject(new Error(`Command timed out: ${command}`));
      }, 120_000);
      this.active = {
        buf: '',
        onOutput: opts?.onOutput,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      void pod.run('bash', ['-lc', script], { terminal: this.worker!, echo: false }).catch((err) => {
        clearTimeout(timer);
        this.active = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async gitClone(url: string, ref?: string): Promise<void> {
    const args = ['clone', url, WORKDIR];
    if (ref) args.push('--branch', ref);
    const r = await this.exec('git', args, { cwd: '/' });
    if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stdout}`);
  }

  async gitCommit(message: string): Promise<{ commit: string }> {
    const add = await this.exec('git', ['add', '-A']);
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stdout}`);
    const commit = await this.exec('git', ['commit', '-m', message, '--allow-empty']);
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stdout}`);
    const rev = await this.exec('git', ['rev-parse', 'HEAD']);
    return { commit: rev.stdout.trim() };
  }

  async gitPush(): Promise<void> {
    const r = await this.exec('git', ['push', 'origin', 'HEAD']);
    if (r.exitCode !== 0) throw new Error(`git push failed: ${r.stdout}`);
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
      const bin = await pod.openFile(this.abs(e.path), 'rb');
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
    this.active = null;
    this.pod = null;
    this.worker = null;
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
