import type { SupabaseClient } from '@supabase/supabase-js';
import type { SandboxProvider } from './sandbox';
import {
  STUDIO_COMMAND_EVENT,
  STUDIO_RESULT_EVENT,
  studioChannelTopic,
  type StudioCommandEnvelope,
  type StudioOp,
  type StudioResult,
  type StudioResultEnvelope,
} from './protocol';

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
    case 'buildZip':
      return provider.buildZip(op.dir);
  }
}

/**
 * Bridge listener (browser side of arch A): subscribe to the tenant's private Realtime channel,
 * execute the technical agent's commands in the local sandbox, and broadcast the result back. Only
 * commands for THIS session id are handled, so multiple tabs of one tenant don't collide.
 */
export function runStudioBridge(args: {
  supabase: SupabaseClient;
  authToken: string;
  tenantId: string;
  sessionId: string;
  provider: SandboxProvider;
}): () => void {
  const { supabase, authToken, tenantId, sessionId, provider } = args;
  let cancelled = false;
  let channel: ReturnType<SupabaseClient['channel']> | null = null;

  void (async () => {
    await supabase.realtime.setAuth(authToken);
    if (cancelled) return;
    const topic = studioChannelTopic(tenantId);
    channel = supabase.channel(topic, { config: { private: true } });

    channel
      .on('broadcast', { event: STUDIO_COMMAND_EVENT }, (msg: { payload?: unknown }) => {
        const env = msg.payload as StudioCommandEnvelope | undefined;
        if (!env || env.sessionId !== sessionId) return; // not for this tab
        console.info(`[studio] bridge received cmd ${env.op.op} (${env.cmdId.slice(0, 8)})`);
        void handleCommand(env);
      })
      .subscribe((status) => {
        console.info(`[studio] bridge channel ${topic}: ${status}`);
      });
  })();

  async function handleCommand(env: StudioCommandEnvelope): Promise<void> {
    let reply: StudioResultEnvelope;
    try {
      const result = await dispatch(env.op, provider);
      reply = { cmdId: env.cmdId, sessionId, ok: true, result };
    } catch (err) {
      reply = {
        cmdId: env.cmdId,
        sessionId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (cancelled || !channel) return;
    const sent = await channel.send({ type: 'broadcast', event: STUDIO_RESULT_EVENT, payload: reply });
    console.info(`[studio] bridge replied ${env.op.op} (${env.cmdId.slice(0, 8)}) ok=${reply.ok} send=${String(sent)}`);
  }

  return () => {
    cancelled = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
