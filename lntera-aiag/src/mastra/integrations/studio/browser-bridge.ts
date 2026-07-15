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
 *  stream is supposed to self-evict within one heartbeat interval (see the /studio/commands/stream
 *  route), but that only works if a write to it actually throws — a client that vanished silently
 *  (laptop sleep, a network path drop with no TCP RST reaching us) can sit "open" server-side
 *  indefinitely with writes still succeeding into the OS socket buffer. Confirmed in production: a
 *  brand-new Studio session got rejected outright. registerStream() below now actively probes and
 *  evicts this tenant's connections the moment a fresh one needs a slot, instead of only relying on
 *  the next scheduled heartbeat — this cap just needs enough headroom for genuinely-concurrent
 *  legitimate tabs on top of that. */
const MAX_STREAMS_PER_TENANT = 16;

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
    let count = this.tenantStreamCounts.get(tenantId) ?? 0;
    if (count >= MAX_STREAMS_PER_TENANT) {
      // Don't trust the count as-is — some of these slots may be connections whose client vanished
      // without ever tripping a write failure (see MAX_STREAMS_PER_TENANT's comment). Probe every one
      // of this tenant's registered streams right now and evict whichever fail, then recheck before
      // giving up — this is strictly cheaper than making a fresh tab wait out the next heartbeat.
      for (const [sid, conn] of this.connections) {
        if (conn.tenantId !== tenantId) continue;
        try {
          conn.write(': ping\n\n');
        } catch {
          this.evict(sid);
        }
      }
      count = this.tenantStreamCounts.get(tenantId) ?? 0;
      if (count >= MAX_STREAMS_PER_TENANT) {
        throw new StudioBridgeError('Too many open Studio sessions for this tenant.');
      }
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
      this.evict(sessionId, connection);
    };
  }

  /** Drop a registered stream and fail any of its still-in-flight calls. If `expected` is given, only
   *  evicts when it's still the live registration for `sessionId` (a fast reconnect may have already
   *  replaced it before an older stream's own cleanup ran). */
  private evict(sessionId: string, expected?: StudioConnection): void {
    const current = this.connections.get(sessionId);
    if (!current || (expected && current !== expected)) return;
    this.connections.delete(sessionId);
    const remaining = this.tenantStreamCounts.get(current.tenantId) ?? 1;
    if (remaining <= 1) this.tenantStreamCounts.delete(current.tenantId);
    else this.tenantStreamCounts.set(current.tenantId, remaining - 1);
    // The command payload for anything still in flight to this session was written into a stream
    // that's now gone (no replay) — fail fast rather than waiting out the full timeout.
    for (const [cmdId, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      p.reject(new StudioBridgeError('Studio session disconnected'));
      this.pending.delete(cmdId);
    }
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
