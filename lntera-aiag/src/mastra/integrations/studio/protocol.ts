/**
 * Studio browser-bridge protocol (arch A).
 *
 * The server-side technical agent's Workspace tools do not touch a local filesystem — every file /
 * command / git / build op is sent to the user's browser (where the code actually lives in a
 * BrowserPod) as a {@link StudioCommandEnvelope}, and the browser replies with a
 * {@link StudioResultEnvelope}. The transport is a direct, same-backend connection: the browser holds
 * one authenticated Server-Sent-Events stream open per session (`GET .../studio/commands/stream`) and
 * the server writes commands straight into it; the browser replies over a plain
 * `POST .../studio/commands/:cmdId/result`. No third party sits in the path — see browser-bridge.ts.
 * This file is the single source of truth for the envelope contract.
 *
 * NOTE: the web client keeps a byte-for-byte mirror of these types at `web/src/lib/studio/protocol.ts`
 * (the web build cannot import from `src/mastra`). Keep the two in sync.
 */

/** requestContext key carrying the active Studio session (browser tab) id, set by the web client. */
export const STUDIO_SESSION_ID_KEY = 'studioSessionId';

/** A file/dir entry from `listTree`. */
export interface StudioTreeEntry {
  path: string;
  type: 'file' | 'dir';
}

/** One changed file from `gitStatus` (unmodified files are omitted, not just deprioritized). */
export interface StudioGitStatusEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

/** One commit from `gitLog`. */
export interface StudioGitLogEntry {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}

/** All operations the server may ask the browser to perform, discriminated by `op`. */
export type StudioOp =
  | { op: 'writeFile'; path: string; content: string }
  | { op: 'readFile'; path: string }
  | { op: 'listTree'; path?: string }
  | { op: 'deleteFile'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'execCommand'; command: string; args?: string[]; cwd?: string }
  | { op: 'gitClone'; url: string; ref?: string }
  | { op: 'gitCommit'; message: string }
  | { op: 'gitPush' }
  /** Changed files since the last commit — cheap and local, no network. */
  | { op: 'gitStatus' }
  /** Unified diff of uncommitted changes, optionally scoped to one file. */
  | { op: 'gitDiff'; path?: string }
  | { op: 'gitLog'; depth?: number }
  | { op: 'gitListBranches' }
  | { op: 'gitCreateBranch'; name: string; checkout?: boolean }
  | { op: 'gitCheckout'; ref: string }
  /** Read a built directory back as a base64 zip so the server can forward it to the deploy proxy. */
  | { op: 'buildZip'; dir: string }
  /** Health of the auto-started dev server + whether the live preview is up. `waitSeconds` blocks
   *  (polling) until the preview is ready, the server exits, or the wait elapses — the agent's
   *  "wait and see if it actually runs" primitive. */
  | { op: 'checkPreview'; waitSeconds?: number };

export type StudioOpName = StudioOp['op'];

/** Result payload per op (the `ok` case of {@link StudioResultEnvelope}). */
export interface StudioResultByOp {
  writeFile: Record<string, never>;
  readFile: { content: string };
  listTree: { entries: StudioTreeEntry[] };
  deleteFile: Record<string, never>;
  mkdir: Record<string, never>;
  execCommand: { exitCode: number; stdout: string; stderr: string };
  gitClone: Record<string, never>;
  gitCommit: { commit: string };
  gitPush: Record<string, never>;
  gitStatus: { files: StudioGitStatusEntry[] };
  gitDiff: { diff: string };
  gitLog: { commits: StudioGitLogEntry[] };
  gitListBranches: { branches: string[]; current: string };
  gitCreateBranch: Record<string, never>;
  gitCheckout: Record<string, never>;
  buildZip: { zipBase64: string };
  checkPreview: {
    /** 'idle' = never started (e.g. an mcp project); 'exited' = it crashed or stopped. */
    devServer: 'idle' | 'starting' | 'exited';
    exitCode: number | null;
    /** True once the sandbox has detected a bound port and produced a live preview URL. */
    previewReady: boolean;
    /** Recent dev-server output (capped) — where a compile error will show up. */
    outputTail: string;
  };
}

export type StudioResult<K extends StudioOpName = StudioOpName> = StudioResultByOp[K];

/** Server → browser: a correlated command. `sessionId` targets one tab of the tenant. */
export interface StudioCommandEnvelope {
  cmdId: string;
  sessionId: string;
  op: StudioOp;
}

/** Browser → server: the correlated reply (success or failure), echoing `sessionId`. */
export type StudioResultEnvelope<K extends StudioOpName = StudioOpName> =
  | { cmdId: string; sessionId: string; ok: true; result: StudioResult<K> }
  | { cmdId: string; sessionId: string; ok: false; error: string };

/** How long the server waits for a browser reply before failing the tool call. */
export const STUDIO_RPC_TIMEOUT_MS = 120_000;
