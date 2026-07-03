import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StudioBridge, StudioBridgeError, StudioBridgeTimeoutError } from './browser-bridge';
import type { StudioCommandEnvelope, StudioResultEnvelope } from './protocol';

/** In-memory stand-in for one browser tab's SSE connection. */
class FakeSession {
  received: StudioCommandEnvelope[] = [];
  private readonly unregister: () => void;

  constructor(
    private readonly bridge: StudioBridge,
    private readonly tenantId: string,
    private readonly sessionId: string,
  ) {
    this.unregister = bridge.registerStream(tenantId, sessionId, (chunk) => {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) this.received.push(JSON.parse(line.slice(6)) as StudioCommandEnvelope);
    });
  }

  /** Simulate the browser replying to the most recently received command. */
  reply(result: { ok: true; result: unknown } | { ok: false; error: string }, tenantId = this.tenantId): void {
    const env = this.received.at(-1);
    if (!env) throw new Error('no command received');
    this.bridge.resolveResult(tenantId, { cmdId: env.cmdId, sessionId: this.sessionId, ...result } as StudioResultEnvelope);
  }

  disconnect(): void {
    this.unregister();
  }
}

describe('StudioBridge.call', () => {
  it('resolves with the matching reply payload', async () => {
    const bridge = new StudioBridge(1000);
    const session = new FakeSession(bridge, 'tenant1', 's1');
    const p = bridge.call('tenant1', 's1', { op: 'readFile', path: 'a.ts' });
    session.reply({ ok: true, result: { content: 'hello' } });
    assert.deepEqual(await p, { content: 'hello' });
  });

  it('rejects when the browser replies with ok:false', async () => {
    const bridge = new StudioBridge(1000);
    const session = new FakeSession(bridge, 'tenant1', 's1');
    const p = bridge.call('tenant1', 's1', { op: 'execCommand', command: 'npm i' });
    session.reply({ ok: false, error: 'npm exploded' });
    await assert.rejects(p, (e: Error) => e instanceof StudioBridgeError && /npm exploded/.test(e.message));
  });

  it('rejects immediately when there is no active session for that id', async () => {
    const bridge = new StudioBridge(1000);
    await assert.rejects(
      bridge.call('tenant1', 'no-such-session', { op: 'gitPush' }),
      (e: Error) => e instanceof StudioBridgeError && /No active Studio session/.test(e.message),
    );
  });

  it('ignores a result posted by a DIFFERENT tenant than the one who made the call, and still times out', async () => {
    const bridge = new StudioBridge(30);
    const session = new FakeSession(bridge, 'tenant1', 's1');
    const p = bridge.call('tenant1', 's1', { op: 'gitPush' });
    session.reply({ ok: true, result: {} }, 'tenant2'); // foreign tenant — must be ignored, not resolved
    await assert.rejects(p, (e: Error) => e instanceof StudioBridgeTimeoutError);
  });

  it('fails in-flight calls fast when the session disconnects, instead of waiting out the timeout', async () => {
    const bridge = new StudioBridge(1000);
    const session = new FakeSession(bridge, 'tenant1', 's1');
    const p = bridge.call('tenant1', 's1', { op: 'gitPush' });
    session.disconnect();
    await assert.rejects(p, (e: Error) => e instanceof StudioBridgeError && /disconnected/.test(e.message));
  });

  it('resolves multiple in-flight calls to the same session independently', async () => {
    const bridge = new StudioBridge(1000);
    const session = new FakeSession(bridge, 'tenant1', 's1');
    const p1 = bridge.call('tenant1', 's1', { op: 'gitPush' });
    const p2 = bridge.call('tenant1', 's1', { op: 'gitCommit', message: 'x' });
    for (const env of session.received) {
      bridge.resolveResult('tenant1', {
        cmdId: env.cmdId,
        sessionId: 's1',
        ok: true,
        result: env.op.op === 'gitCommit' ? { commit: 'abc' } : {},
      } as StudioResultEnvelope);
    }
    await Promise.all([p1, p2]);
  });

  it('caps concurrent streams per tenant, and frees a slot once a stream unregisters', () => {
    const bridge = new StudioBridge(1000);
    const sessions = Array.from({ length: 8 }, (_, i) => new FakeSession(bridge, 'tenant1', `s${i}`));
    assert.throws(() => bridge.registerStream('tenant1', 's-overflow', () => undefined), StudioBridgeError);
    // Freeing one slot (e.g. the stream's heartbeat write failed, or it cleanly closed — either way
    // the route calls unregister()) immediately allows a new registration again.
    sessions[0].disconnect();
    const revived = new FakeSession(bridge, 'tenant1', 's-revived');
    revived.disconnect();
    for (const s of sessions.slice(1)) s.disconnect();
  });
});
