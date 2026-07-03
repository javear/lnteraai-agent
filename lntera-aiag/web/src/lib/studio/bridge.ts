import type { SandboxProvider } from './sandbox';
import type { StudioCommandEnvelope, StudioOp, StudioResult } from './protocol';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** Run one op against the sandbox and return its typed result payload. */
async function dispatch(op: StudioOp, provider: SandboxProvider): Promise<StudioResult> {
  switch (op.op) {
    case 'writeFile':
      await provider.writeFile(op.path, op.content);
      return {};
    case 'readFile':
      return { content: await provider.readFile(op.path) };
    case 'listTree':
      return { entries: await provider.listTree(op.path) };
    case 'deleteFile':
      await provider.deleteFile(op.path);
      return {};
    case 'mkdir':
      await provider.mkdir(op.path);
      return {};
    case 'execCommand':
      return provider.exec(op.command, op.args, { cwd: op.cwd });
    case 'gitClone':
      await provider.gitClone(op.url, op.ref);
      return {};
    case 'gitCommit':
      return provider.gitCommit(op.message);
    case 'gitPush':
      await provider.gitPush();
      return {};
    case 'gitStatus':
      return { files: await provider.gitStatus() };
    case 'gitDiff':
      return { diff: await provider.gitDiff(op.path) };
    case 'gitLog':
      return { commits: await provider.gitLog(op.depth) };
    case 'gitListBranches':
      return provider.gitListBranches();
    case 'gitCreateBranch':
      await provider.gitCreateBranch(op.name, { checkout: op.checkout });
      return {};
    case 'gitCheckout':
      await provider.gitCheckout(op.ref);
      return {};
    case 'buildZip':
      return provider.buildZip(op.dir);
  }
}

const BASE_RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** A 429 (too many open streams for this tenant) will keep failing for as long as the server's stale
 *  slots take to self-heal (~one heartbeat interval) — retrying at the base delay just hammers it. */
const RATE_LIMITED_RECONNECT_DELAY_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimitedError extends Error {}

/**
 * Bridge listener (browser side): hold one authenticated command stream open for this session,
 * execute the technical agent's commands in the local sandbox, and POST each result straight back to
 * our own backend. Both legs are a single hop to our own server — no third party in the path.
 *
 * Deliberately NOT `EventSource`: it can't send an `Authorization` header, and putting the real
 * access token in the URL instead would leak it into server/proxy access logs. `api()` (the same
 * authenticated-fetch helper every other Studio call uses) is reused here instead, with the
 * event-stream body parsed by hand.
 */
export function runStudioBridge(args: { api: Api; sessionId: string; provider: SandboxProvider }): () => void {
  const { api, sessionId, provider } = args;
  let cancelled = false;
  let abort: AbortController | null = null;

  void (async function loop() {
    // Exponential backoff on consecutive failures (capped) — a real network blip should reconnect
    // fast, but a persistently broken connection (or a 429) must NOT retry in a tight loop against
    // the server. A single clean connection (pump() only returns once the stream actually ends)
    // resets this back to the base delay.
    let delay = BASE_RECONNECT_DELAY_MS;
    while (!cancelled) {
      abort = new AbortController();
      try {
        await pump(api, sessionId, provider, abort.signal);
        delay = BASE_RECONNECT_DELAY_MS;
      } catch (err) {
        if (!cancelled) console.info('[studio] command stream dropped, reconnecting', err);
        delay = err instanceof RateLimitedError ? RATE_LIMITED_RECONNECT_DELAY_MS : Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      }
      if (cancelled) return;
      await sleep(delay);
    }
  })();

  return () => {
    cancelled = true;
    abort?.abort();
  };
}

/**
 * Open the stream and dispatch commands as they arrive. Resolves when the connection ends (server
 * close, network drop, or `signal` aborting) so the caller's loop can reconnect with the same
 * sessionId — an in-flight command that was written into the now-dead stream fails on the server
 * side (see browser-bridge.ts's disconnect handling) rather than being silently lost forever.
 */
async function pump(api: Api, sessionId: string, provider: SandboxProvider, signal: AbortSignal): Promise<void> {
  const res = await api(`/svc/v1/studio/commands/stream?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (res.status === 429) throw new RateLimitedError(`Studio command stream rate-limited (429)`);
  if (!res.ok || !res.body) throw new Error(`Studio command stream failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // comment/heartbeat frame (e.g. `: ping`) — nothing to do
      let envelope: StudioCommandEnvelope;
      try {
        envelope = JSON.parse(dataLine.slice(6)) as StudioCommandEnvelope;
      } catch {
        continue; // malformed frame — ignore rather than kill the whole stream
      }
      if (envelope.sessionId !== sessionId) continue; // defensive; the server only ever targets us
      void handleCommand(api, provider, envelope);
    }
  }
}

async function handleCommand(api: Api, provider: SandboxProvider, env: StudioCommandEnvelope): Promise<void> {
  let body: { ok: true; sessionId: string; result: StudioResult } | { ok: false; sessionId: string; error: string };
  try {
    const result = await dispatch(env.op, provider);
    body = { ok: true, sessionId: env.sessionId, result };
  } catch (err) {
    body = { ok: false, sessionId: env.sessionId, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await api(`/svc/v1/studio/commands/${env.cmdId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.info(`[studio] failed to post result for ${env.op.op} (${env.cmdId.slice(0, 8)})`, err);
  }
}
