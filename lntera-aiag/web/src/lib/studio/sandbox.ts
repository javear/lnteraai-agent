import type { StudioTreeEntry } from './protocol';

/**
 * The in-browser code runtime the Studio drives. Swappable (BrowserPod today; WebContainers or a
 * remote E2B sandbox later) — the Realtime bridge listener + the UI depend only on this interface,
 * never on a concrete runtime.
 */
export interface SandboxProvider {
  /** Boot the runtime (idempotent). */
  boot(): Promise<void>;

  // Filesystem
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  listTree(path?: string): Promise<StudioTreeEntry[]>;
  deleteFile(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;

  /**
   * Run a command to completion. `onOutput` streams stdout/stderr chunks live (for the xterm
   * terminal); the resolved value is the final aggregate + exit code.
   */
  exec(
    command: string,
    args?: string[],
    opts?: { cwd?: string; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  // Git (isomorphic-git through the server CORS proxy → Gitea Cloud)
  gitClone(url: string, ref?: string): Promise<void>;
  gitCommit(message: string): Promise<{ commit: string }>;
  gitPush(): Promise<void>;

  /** Zip a built directory (base64) so the server deploy proxy can forward it to EdgeOne. */
  buildZip(dir: string): Promise<{ zipBase64: string }>;

  /** Public preview URL for a server running inside the sandbox (BrowserPod Portal), or null. */
  previewUrl(): string | null;

  dispose(): Promise<void>;
}

/**
 * BrowserPod-backed provider. STUB — the concrete BrowserPod SDK wiring lands in the Phase 0 spike
 * once `VITE_BROWSERPOD_KEY` is configured. Every method throws until then so nothing silently
 * no-ops; the interface above is the stable contract the rest of Studio is built against.
 */
export class BrowserPodProvider implements SandboxProvider {
  constructor(private readonly opts: { apiKey?: string } = {}) {}

  private notReady(): never {
    throw new Error(
      'BrowserPod is not configured yet (set VITE_BROWSERPOD_KEY and complete the Phase 0 spike wiring).',
    );
  }

  async boot(): Promise<void> {
    void this.opts;
    this.notReady();
  }
  writeFile(): Promise<void> {
    this.notReady();
  }
  readFile(): Promise<string> {
    this.notReady();
  }
  listTree(): Promise<StudioTreeEntry[]> {
    this.notReady();
  }
  deleteFile(): Promise<void> {
    this.notReady();
  }
  mkdir(): Promise<void> {
    this.notReady();
  }
  exec(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.notReady();
  }
  gitClone(): Promise<void> {
    this.notReady();
  }
  gitCommit(): Promise<{ commit: string }> {
    this.notReady();
  }
  gitPush(): Promise<void> {
    this.notReady();
  }
  buildZip(): Promise<{ zipBase64: string }> {
    this.notReady();
  }
  previewUrl(): string | null {
    return null;
  }
  async dispose(): Promise<void> {
    /* no-op until booted */
  }
}
