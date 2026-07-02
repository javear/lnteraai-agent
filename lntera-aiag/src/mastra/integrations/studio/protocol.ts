/**
 * Studio browser-bridge protocol (arch A).
 *
 * The server-side technical agent's Workspace tools do not touch a local filesystem — every file /
 * command / git / build op is sent to the user's browser (where the code actually lives in a
 * BrowserPod) as a {@link StudioCommandEnvelope} over a Supabase Realtime channel, and the browser
 * replies with a {@link StudioResultEnvelope}. This file is the single source of truth for that
 * contract.
 *
 * NOTE: the web client keeps a byte-for-byte mirror of these types at `web/src/lib/studio/protocol.ts`
 * (the web build cannot import from `src/mastra`). Keep the two in sync.
 */

/**
 * Realtime topic. We REUSE the tenant's existing private channel (`tenant:{id}`) rather than a
 * studio-specific sub-topic, because the Realtime RLS policy (migration 0009) authorizes exactly
 * `tenant:{id}` for that tenant's members — a `tenant:{id}:studio:{sid}` topic would be rejected.
 * Studio traffic is namespaced by event name; multiple tabs of one tenant are disambiguated by the
 * `sessionId` carried in every envelope.
 */
export function studioChannelTopic(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/** Broadcast event names on the tenant channel (namespaced so they don't clash with notifications). */
export const STUDIO_COMMAND_EVENT = 'studio_cmd';
export const STUDIO_RESULT_EVENT = 'studio_result';

/** A file/dir entry from `listTree`. */
export interface StudioTreeEntry {
  path: string;
  type: 'file' | 'dir';
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
  /** Read a built directory back as a base64 zip so the server can forward it to the deploy proxy. */
  | { op: 'buildZip'; dir: string };

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
  buildZip: { zipBase64: string };
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
