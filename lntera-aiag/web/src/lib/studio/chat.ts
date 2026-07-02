import type { MastraClient } from '@mastra/client-js';
import { browserTimezone } from '../insights';
import { friendlyStreamError, parseModelLabel, type StreamHandlers } from '../chat';
import type { StudioProjectKind } from './api';

/** Matches the server agent id (src/mastra/agents/technical-agent.ts). */
export const STUDIO_AGENT_ID = 'technical-agent';

function currentLang(): string {
  try {
    return localStorage.getItem('lntera-lang') || 'en';
  } catch {
    return 'en';
  }
}

/**
 * Stream one turn from the technical agent. Identical shape to the business-agent `streamChat`, but
 * targets `technical-agent` and carries the Studio session id + project kind so the agent's tools
 * bridge to THIS browser tab's sandbox. `pinnedModel` lets the user pick a coding model.
 */
export async function streamStudioChat(
  client: MastraClient,
  message: string,
  args: { threadId: string; resource: string; sessionId: string; kind: StudioProjectKind; pinnedModel?: string },
  handlers: StreamHandlers,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  try {
    const res = await client.getAgent(STUDIO_AGENT_ID).stream([{ role: 'user', content: message }], {
      memory: { thread: args.threadId, resource: args.resource },
      requestContext: {
        channel: 'studio',
        timezone: browserTimezone(),
        nowIso: new Date().toISOString(),
        language: currentLang(),
        studioSessionId: args.sessionId,
        projectKind: args.kind,
        ...(args.pinnedModel ? { groqModel: args.pinnedModel } : {}),
      } as never,
    });

    await res.processDataStream({
      onChunk: async (chunk: any) => {
        if (shouldStop()) return;
        const payload = chunk?.payload ?? {};
        switch (chunk?.type) {
          case 'reasoning-delta': {
            const r =
              typeof payload.text === 'string'
                ? payload.text
                : typeof payload.delta === 'string'
                  ? payload.delta
                  : '';
            if (r) handlers.onReasoning?.(r);
            break;
          }
          case 'text-delta':
            if (typeof payload.text === 'string') handlers.onText(payload.text);
            break;
          case 'tool-call':
            handlers.onToolStart?.(typeof payload.toolName === 'string' ? payload.toolName : 'tool');
            break;
          case 'tripwire':
            handlers.onTripwire?.(payload.metadata?.code, payload.reason ?? 'Request blocked.');
            break;
          case 'step-finish':
          case 'finish': {
            const id = payload.response?.modelId ?? payload.metadata?.modelId;
            const label = parseModelLabel(id);
            if (label) handlers.onModel?.(label);
            break;
          }
          case 'error':
            handlers.onError?.(friendlyStreamError(payload.error ?? payload));
            break;
        }
      },
    });
  } catch (err) {
    handlers.onError?.(friendlyStreamError(err));
  }
}
