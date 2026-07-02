import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StudioBridge, StudioBridgeError, StudioBridgeTimeoutError, type StudioBridgeTransport } from './browser-bridge';
import type { StudioCommandEnvelope, StudioResultEnvelope } from './protocol';

/** Yield a macrotask so the bridge's async subscribe+publish finishes before we assert/reply. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** In-memory transport: records published commands and lets tests push replies. */
class FakeTransport implements StudioBridgeTransport {
  sent: StudioCommandEnvelope[] = [];
  handler: ((r: StudioResultEnvelope) => void) | null = null;
  subscribeCalls = 0;
  failPublish = false;

  async publishCommand(_topic: string, envelope: StudioCommandEnvelope): Promise<void> {
    if (this.failPublish) throw new Error('publish boom');
    this.sent.push(envelope);
  }
  subscribeResults(_topic: string, handler: (r: StudioResultEnvelope) => void): () => void {
    this.subscribeCalls++;
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  /** Simulate the browser replying to a command (union kept explicit — Omit collapses it). */
  reply(
    result:
      | { cmdId: string; ok: true; result: unknown }
      | { cmdId: string; ok: false; error: string },
    sessionId = 's1',
  ): void {
    this.handler?.({ ...result, sessionId } as StudioResultEnvelope);
  }
  last(): StudioCommandEnvelope {
    const e = this.sent.at(-1);
    if (!e) throw new Error('no command sent');
    return e;
  }
}

describe('StudioBridge.call', () => {
  it('resolves with the matching reply payload', async () => {
    const t = new FakeTransport();
    const bridge = new StudioBridge(t, 1000);
    const p = bridge.call('tenant1', 's1', { op: 'readFile', path: 'a.ts' });
    // reply once the command has been published (subscription is set up in call()).
    await tick();
    t.reply({ cmdId: t.last().cmdId, ok: true, result: { content: 'hello' } });
    assert.deepEqual(await p, { content: 'hello' });
  });

  it('rejects when the browser replies with ok:false', async () => {
    const t = new FakeTransport();
    const bridge = new StudioBridge(t, 1000);
    const p = bridge.call('tenant1', 's1', { op: 'execCommand', command: 'npm i' });
    await tick();
    t.reply({ cmdId: t.last().cmdId, ok: false, error: 'npm exploded' });
    await assert.rejects(p, (e: Error) => e instanceof StudioBridgeError && /npm exploded/.test(e.message));
  });

  it('ignores replies for unknown cmdIds (multi-instance safe) and still times out', async () => {
    const t = new FakeTransport();
    const bridge = new StudioBridge(t, 30);
    const p = bridge.call('tenant1', 's1', { op: 'gitPush' });
    await tick();
    t.reply({ cmdId: 'some-other-instance-cmd', ok: true, result: {} }); // foreign — must be ignored
    await assert.rejects(p, (e: Error) => e instanceof StudioBridgeTimeoutError);
  });

  it('propagates a publish failure as a rejection', async () => {
    const t = new FakeTransport();
    t.failPublish = true;
    const bridge = new StudioBridge(t, 1000);
    await assert.rejects(
      bridge.call('tenant1', 's1', { op: 'gitPush' }),
      (e: Error) => /publish boom/.test(e.message),
    );
  });

  it('subscribes once per tenant topic across multiple calls', async () => {
    const t = new FakeTransport();
    const bridge = new StudioBridge(t, 1000);
    const p1 = bridge.call('tenant1', 's1', { op: 'gitPush' });
    const p2 = bridge.call('tenant1', 's1', { op: 'gitCommit', message: 'x' });
    await tick();
    assert.equal(t.subscribeCalls, 1);
    // resolve both by cmdId so the test doesn't leak pending timers
    for (const env of t.sent) {
      t.reply({ cmdId: env.cmdId, ok: true, result: env.op.op === 'gitCommit' ? { commit: 'abc' } : {} });
    }
    await Promise.all([p1, p2]);
  });
});
