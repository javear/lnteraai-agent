import { randomUUID } from 'node:crypto';
import { getSupabase, getSupabaseServiceConfig } from '../shared/supabase';
import { logErrorBrief } from '../../logger/compact-error';
import {
  STUDIO_COMMAND_EVENT,
  STUDIO_RESULT_EVENT,
  STUDIO_RPC_TIMEOUT_MS,
  studioChannelTopic,
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

/**
 * Pluggable transport for the bridge — kept separate from the correlation logic so the latter is
 * unit-testable without Supabase. `subscribeResults` returns an unsubscribe fn (sync or async).
 */
export interface StudioBridgeTransport {
  publishCommand(topic: string, envelope: StudioCommandEnvelope): Promise<void>;
  subscribeResults(
    topic: string,
    handler: (result: StudioResultEnvelope) => void,
  ): Promise<() => void> | (() => void);
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Correlated request/response over a fire-and-forget broadcast transport (arch A). `call()` publishes
 * a command with a fresh `cmdId` and resolves when the browser replies with the same `cmdId`. Replies
 * for unknown `cmdId`s are ignored, so multiple server instances can share the tenant channel and each
 * only resolves its own in-flight calls.
 */
export class StudioBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly subs = new Map<string, () => void>();
  private readonly subscribing = new Map<string, Promise<void>>();

  constructor(
    private readonly transport: StudioBridgeTransport,
    private readonly timeoutMs: number = STUDIO_RPC_TIMEOUT_MS,
  ) {}

  private async ensureSubscribed(topic: string): Promise<void> {
    if (this.subs.has(topic)) return;
    let inflight = this.subscribing.get(topic);
    if (!inflight) {
      inflight = (async () => {
        const unsub = await this.transport.subscribeResults(topic, (r) => this.onResult(r));
        this.subs.set(topic, unsub);
      })();
      this.subscribing.set(topic, inflight);
    }
    try {
      await inflight;
    } finally {
      this.subscribing.delete(topic);
    }
  }

  private onResult(result: StudioResultEnvelope): void {
    const pending = this.pending.get(result.cmdId);
    if (!pending) return; // unknown / another instance's cmdId — ignore.
    this.pending.delete(result.cmdId);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new StudioBridgeError(result.error));
  }

  /** Send one op to the browser and await its result (typed by the op). */
  async call<K extends StudioOpName>(
    tenantId: string,
    sessionId: string,
    op: Extract<StudioOp, { op: K }>,
  ): Promise<StudioResult<K>> {
    const topic = studioChannelTopic(tenantId);
    await this.ensureSubscribed(topic);

    const cmdId = randomUUID();
    const envelope: StudioCommandEnvelope = { cmdId, sessionId, op };

    return new Promise<StudioResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new StudioBridgeTimeoutError(`Studio op '${op.op}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(cmdId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      Promise.resolve(this.transport.publishCommand(topic, envelope)).catch((err) => {
        const pending = this.pending.get(cmdId);
        if (!pending) return;
        this.pending.delete(cmdId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new StudioBridgeError(String(err)));
      });
    });
  }

  /** Tear down subscriptions and fail any in-flight calls (e.g. on shutdown). */
  async dispose(): Promise<void> {
    for (const unsub of this.subs.values()) {
      try {
        unsub();
      } catch (err) {
        logErrorBrief('[studio] bridge unsubscribe failed', err);
      }
    }
    this.subs.clear();
    for (const [cmdId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new StudioBridgeError('Studio bridge disposed'));
      this.pending.delete(cmdId);
    }
  }
}

/**
 * Real transport: publishes commands via the Supabase Realtime REST endpoint (service key, like
 * {@link broadcastTenantNotification}) and receives replies by subscribing to the tenant's private
 * channel server-side. NOTE: private-channel receive requires the service key on the socket
 * (`realtime.setAuth`) — validate end-to-end in the Phase 0 spike.
 */
export class SupabaseRealtimeTransport implements StudioBridgeTransport {
  async publishCommand(topic: string, envelope: StudioCommandEnvelope): Promise<void> {
    const cfg = getSupabaseServiceConfig();
    if (!cfg) throw new StudioBridgeError('Supabase service config is not available.');
    const res = await fetch(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        messages: [{ topic, event: STUDIO_COMMAND_EVENT, private: true, payload: envelope }],
      }),
    });
    if (!res.ok) {
      throw new StudioBridgeError(`Studio command broadcast failed (${res.status}).`);
    }
  }

  subscribeResults(topic: string, handler: (result: StudioResultEnvelope) => void): () => void {
    const supabase = getSupabase();
    const cfg = getSupabaseServiceConfig();
    if (cfg) supabase.realtime.setAuth(cfg.key);
    const channel = supabase
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: STUDIO_RESULT_EVENT }, (msg: { payload?: unknown }) => {
        if (msg.payload) handler(msg.payload as StudioResultEnvelope);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }
}

let singleton: StudioBridge | null = null;
/** Process-wide bridge over the real Supabase transport. */
export function getStudioBridge(): StudioBridge {
  if (!singleton) singleton = new StudioBridge(new SupabaseRealtimeTransport());
  return singleton;
}
