import { randomUUID } from 'node:crypto';
import {
  STUDIO_RPC_TIMEOUT_MS,
  type StudioCommandEnvelope,
  type StudioOp,
  type StudioOpName,
  type StudioResult,
  type StudioResultEnvelope,
} from './protocol';

export class StudioBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioBridgeError';
  }
}
export class StudioBridgeTimeoutError extends StudioBridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'StudioBridgeTimeoutError';
  }
}

/** Max concurrent open Studio command streams per tenant — a cheap abuse/resource-exhaustion guard
 *  (this process holds one open HTTP response per stream; see RAILWAY.md — single instance). A dead
 *  stream now self-evicts within one heartbeat interval (see the /studio/commands/stream route), so
 *  this only needs to cover genuinely-concurrent legitimate tabs, not "however many reloads happened
 *  before cleanup caught up." */
const MAX_STREAMS_PER_TENANT = 8;

interface StudioConnection {
  tenantId: string;
  write: (chunk: string) => void;
}

interface Pending {
  tenantId: string;
  sessionId: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Server-side half of the Studio command bridge (arch A). The browser holds one HTTP connection open
 * per session (Server-Sent Events, see the `/studio/commands/stream` route); `call()` writes a
 * correlated command directly into that stream — an in-process function call, not a third-party
 * relay — and resolves when the browser POSTs back a matching result. Tenant/session identity comes
 * from the route handlers' verified bearer tokens, never from client-supplied fields, so one tenant
 * can neither dispatch into nor resolve another tenant's session.
 */
export class StudioBridge {
  private readonly connections = new Map<string, StudioConnection>(); // key: sessionId
  private readonly tenantStreamCounts = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number = STUDIO_RPC_TIMEOUT_MS) {}

  /**
   * Register a newly-opened SSE stream for `sessionId`. Returns the unregister fn — call it exactly
   * once, when the stream closes (client disconnect, navigation, network drop).
   */
  registerStream(tenantId: string, sessionId: string, write: (chunk: string) => void): () => void {
    // sessionId is a client-generated UUID (crypto.randomUUID()), so a collision is not something a
    // legitimate reconnect of the SAME tenant would trigger — refuse outright rather than letting a
    // different tenant silently take over an existing binding.
    const existing = this.connections.get(sessionId);
    if (existing && existing.tenantId !== tenantId) {
      throw new StudioBridgeError('Session id already in use.');
    }
    const count = this.tenantStreamCounts.get(tenantId) ?? 0;
    if (count >= MAX_STREAMS_PER_TENANT) {
      throw new StudioBridgeError('Too many open Studio sessions for this tenant.');
    }
    const connection: StudioConnection = { tenantId, write };
    this.connections.set(sessionId, connection);
    this.tenantStreamCounts.set(tenantId, count + 1);

    let dropped = false;
    return () => {
      if (dropped) return;
      dropped = true;
      // Only clear the registry slot if this registration is still the live one — a fast reconnect
      // may have already replaced it before this (older) stream's own cleanup ran.
      if (this.connections.get(sessionId) === connection) this.connections.delete(sessionId);
      const remaining = this.tenantStreamCounts.get(tenantId) ?? 1;
      if (remaining <= 1) this.tenantStreamCounts.delete(tenantId);
      else this.tenantStreamCounts.set(tenantId, remaining - 1);
      // The command payload for anything still in flight to this session was written into a stream
      // that's now gone (no replay) — fail fast rather than waiting out the full timeout.
      for (const [cmdId, p] of this.pending) {
        if (p.sessionId !== sessionId) continue;
        clearTimeout(p.timer);
        p.reject(new StudioBridgeError('Studio session disconnected'));
        this.pending.delete(cmdId);
      }
    };
  }

  /**
   * Send one op to the browser and await its result (typed by the op). `tenantId` must be the
   * caller's OWN verified tenant — it's bound into the pending entry so only a matching tenant's
   * result post can ever resolve it.
   */
  call<K extends StudioOpName>(
    tenantId: string,
    sessionId: string,
    op: Extract<StudioOp, { op: K }>,
  ): Promise<StudioResult<K>> {
    const conn = this.connections.get(sessionId);
    if (!conn || conn.tenantId !== tenantId) {
      return Promise.reject(
        new StudioBridgeError('No active Studio session — open the Studio tab to run this.'),
      );
    }

    const cmdId = randomUUID();
    const envelope: StudioCommandEnvelope = { cmdId, sessionId, op };

    return new Promise<StudioResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new StudioBridgeTimeoutError(`Studio op '${op.op}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(cmdId, {
        tenantId,
        sessionId,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        conn.write(`data: ${JSON.stringify(envelope)}\n\n`);
      } catch (err) {
        this.pending.delete(cmdId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new StudioBridgeError(String(err)));
      }
    });
  }

  /**
   * Ingest a result posted back by the browser. `tenantId` is the verified caller of the result
   * route. An unknown/expired `cmdId`, or one that resolves to a DIFFERENT tenant/session, is
   * silently ignored rather than erroring — surfacing a distinction there would let a caller probe
   * for other tenants' in-flight command ids.
   */
  resolveResult(tenantId: string, result: StudioResultEnvelope): void {
    const pending = this.pending.get(result.cmdId);
    if (!pending || pending.tenantId !== tenantId || pending.sessionId !== result.sessionId) return;
    this.pending.delete(result.cmdId);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new StudioBridgeError(result.error));
  }

  /** Tear down all connections and fail any in-flight calls (e.g. on shutdown). */
  dispose(): void {
    this.connections.clear();
    this.tenantStreamCounts.clear();
    for (const [cmdId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new StudioBridgeError('Studio bridge disposed'));
      this.pending.delete(cmdId);
    }
  }
}

let singleton: StudioBridge | null = null;
/** Process-wide bridge — safe as an in-memory singleton because this app runs as a single Railway
 *  instance (see RAILWAY.md); a horizontally-scaled deployment would need a shared registry instead. */
export function getStudioBridge(): StudioBridge {
  if (!singleton) singleton = new StudioBridge();
  return singleton;
}
