/**
 * Studio browser-bridge protocol — MIRROR of the server contract at
 * `src/mastra/integrations/studio/protocol.ts`. The web build can't import from `src/mastra`, so
 * these types are duplicated; keep the two byte-for-byte in sync.
 */

/** Reuse the tenant's existing private channel (RLS authorizes exactly `tenant:{id}`). */
export function studioChannelTopic(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export const STUDIO_COMMAND_EVENT = 'studio_cmd';
export const STUDIO_RESULT_EVENT = 'studio_result';
export const STUDIO_SESSION_ID_KEY = 'studioSessionId';

export interface StudioTreeEntry {
  path: string;
  type: 'file' | 'dir';
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
