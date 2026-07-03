/**
 * Studio browser-bridge protocol — MIRROR of the server contract at
 * `src/mastra/integrations/studio/protocol.ts`. The web build can't import from `src/mastra`, so
 * these types are duplicated; keep the two byte-for-byte in sync.
 *
 * Transport: one authenticated SSE stream per session (`GET .../studio/commands/stream`) carries
 * commands from the server; the browser replies over `POST .../studio/commands/:cmdId/result`. Direct
 * to our own backend — no third party in the path.
 */

export const STUDIO_SESSION_ID_KEY = 'studioSessionId';

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
  | { op: 'gitStatus' }
  | { op: 'gitDiff'; path?: string }
  | { op: 'gitLog'; depth?: number }
  | { op: 'gitListBranches' }
  | { op: 'gitCreateBranch'; name: string; checkout?: boolean }
  | { op: 'gitCheckout'; ref: string }
  | { op: 'buildZip'; dir: string };

export type StudioOpName = StudioOp['op'];

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
}

export type StudioResult<K extends StudioOpName = StudioOpName> = StudioResultByOp[K];

export interface StudioCommandEnvelope {
  cmdId: string;
  sessionId: string;
  op: StudioOp;
}

export type StudioResultEnvelope<K extends StudioOpName = StudioOpName> =
  | { cmdId: string; sessionId: string; ok: true; result: StudioResult<K> }
  | { cmdId: string; sessionId: string; ok: false; error: string };

export const STUDIO_RPC_TIMEOUT_MS = 120_000;
