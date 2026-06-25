// Runs ONE tenant's one-shot scheduled task when its armed event fires: validate against the DB, run
// the FULL general agent with the stored instruction (tools enabled — so "send me a tax recap" or
// "check my TikTok orders" actually execute), and post the result into the tenant's Notifications chat.
// Robustness:
//  - DB `status` is the authority: only a still-'scheduled' task runs, and it's marked done/error at the
//    end → a duplicate/retried event no-ops once it's terminal.
//  - The fired event's targetTs must still match the task's run_at (a rescheduled task got a new event;
//    the stale one is rejected).
//  - run + deliver + mark happen in ONE memoized step so a later retry never re-delivers.
//  - A schedule cancel/replace sends task/run.canceled → drops this tenant's superseded pending run.
import { RequestContext } from '@mastra/core/request-context';
import { inngest } from '../client';
import { generalAgent } from '../../agents/general-agent';
import { TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { AGENT_MODE_KEY, type AgentMode } from '../../active-mode/notifier';
import { deliverTenantWebNotification } from '../../active-mode/web-delivery';
import { getScheduledTask, markScheduledTaskStatus } from '../../integrations/shared/scheduled-task-prefs';
import { SCHEDULED_TASK_RUN_EVENT, SCHEDULED_TASK_CANCEL_EVENT } from '../arm-scheduled-task';

interface RunTaskEventData {
  tenantId: string;
  taskId?: string;
  targetTs?: number;
}

const RETRY_BACKOFF_MS = [3000, 9000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Transient = worth waiting out (provider spike / 429 / 5xx / timeout); permanent → give up now. */
function isTransientLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /unavailable|high demand|temporar|overload|server error|try again|rate.?limit|too many requests|quota|timeout|timed out|econnreset|etimedout|fetch failed|\b(429|500|502|503|504)\b/.test(
    msg,
  );
}

/**
 * Run the general agent with the user's stored instruction; returns the answer text (or '' if none).
 * Retries TRANSIENT provider errors with short backoff so a temporary spike doesn't mark the one-shot
 * task failed. A permanent error (no LLM key, etc.) or the last attempt rethrows → caller marks 'error'.
 */
async function runAgentForTask(tenantId: string, prompt: string): Promise<string> {
  const requestContext = new RequestContext();
  requestContext.set(TENANT_MASTER_ID_KEY, tenantId);
  requestContext.set('channel', 'web');
  requestContext.set(AGENT_MODE_KEY, 'active' satisfies AgentMode);

  const maxAttempts = RETRY_BACKOFF_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const answer = (await generalAgent.generate(prompt, { requestContext, maxSteps: 8 })) as {
        text?: unknown;
        tripwire?: unknown;
      };
      if (answer.tripwire) return '';
      return typeof answer.text === 'string' ? answer.text.trim() : '';
    } catch (err) {
      if (!isTransientLlmError(err) || attempt === maxAttempts) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
  return '';
}

export const runScheduledTaskFn = inngest.createFunction(
  {
    id: 'run-scheduled-task',
    concurrency: [{ limit: 4 }, { key: 'event.data.tenantId', limit: 1 }],
    retries: 3,
    cancelOn: [{ event: SCHEDULED_TASK_CANCEL_EVENT, match: 'data.tenantId' }],
    triggers: [{ event: SCHEDULED_TASK_RUN_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as RunTaskEventData;
    const tenantId = data.tenantId;

    return await step.run('run-and-deliver', async () => {
      const task = await getScheduledTask(tenantId);
      if (!task || task.status !== 'scheduled') return { ran: false as const, reason: 'not-scheduled' };
      if (typeof data.targetTs === 'number' && Math.abs(new Date(task.runAt).getTime() - data.targetTs) > 60_000) {
        return { ran: false as const, reason: 'stale-occurrence' }; // rescheduled; the new event covers it
      }

      try {
        const text = await runAgentForTask(tenantId, task.prompt);
        const delivered = text || 'I ran your scheduled task, but could not produce a response this time.';
        await deliverTenantWebNotification({
          tenantId,
          text: delivered,
          heading: 'Scheduled task',
          kind: 'insight',
        });
        await markScheduledTaskStatus(task.id, 'done', { result: delivered, ranAt: new Date() });
        return { ran: true as const, status: 'done' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markScheduledTaskStatus(task.id, 'error', { error: message, ranAt: new Date() });
        // Let the user know the scheduled task didn't go through (best-effort).
        await deliverTenantWebNotification({
          tenantId,
          text: `I couldn't finish your scheduled task this time. You can ask me to try it again.\n\nRequest: ${task.prompt}`,
          heading: 'Scheduled task failed',
          kind: 'insight',
        }).catch(() => {});
        return { ran: false as const, reason: 'error' };
      }
    });
  },
);
