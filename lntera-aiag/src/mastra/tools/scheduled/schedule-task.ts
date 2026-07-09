// Agent-callable: schedule a FUTURE action. The seller tells the agent to do something later ("send me
// a tax recap by 10am tomorrow", "check my TikTok orders at 4pm", "remind me to restock in 2 hours")
// and at that time the FULL agent runs the instruction and posts the result into their Notifications
// chat. One scheduled task per tenant: a new request while one is pending COMBINES into it (same fire
// time unless a new time is given). Supports cancel + status.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import {
  cancelScheduledTask,
  combineScheduledTask,
  describeRunAt,
  getScheduledTask,
  isPending,
  resolveWhen,
  setScheduledTask,
} from '../../integrations/shared/scheduled-task-prefs';
import { armScheduledTask, cancelScheduledTaskRun } from '../../inngest/arm-scheduled-task';

const inputSchema = z.record(z.string(), z.unknown());

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export const scheduleTaskTool = createTool({
  id: 'schedule-future-task',
  strict: false,
  description:
    'Schedule the agent to do something LATER and notify the user at that time. Use when the user asks you to do/send/check/remind something at a future time ("send me a tax recap by 10am tomorrow", "check my TikTok orders at 4pm", "in 2 hours summarize today\'s sales"). One scheduled task per tenant: if one is already pending a new request is COMBINED into it (set action="replace" to overwrite instead). `action`: set (default) | replace | cancel | status. `prompt`: what to do at run time, phrased as an instruction to yourself. `when`: the time in the user\'s words ("10am tomorrow", "4pm", "in 2 hours", "Friday 9am") — omit only when combining and keeping the same time, or for cancel/status. Optional `timezone` (IANA).',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
    timezone: z.string().optional().describe("The user's local IANA timezone, if the client sent one."),
  }),
  inputSchema,
  inputExamples: [
    { input: { prompt: 'Generate my tax recap for this month and send it to me.', when: '10am tomorrow' } },
    { input: { prompt: 'Check my TikTok orders that still need to be processed.', when: '4pm' } },
    { input: { action: 'status' } },
    { input: { action: 'cancel' } },
  ],
  outputSchema: z.object({
    status: z.enum(['scheduled', 'combined', 'replaced', 'canceled', 'none', 'error']),
    runAt: z.string().nullable(),
    summaryText: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const action = (str(raw.action) ?? 'set').toLowerCase();
    const prompt = str(raw.prompt ?? raw.instruction ?? raw.task);
    const when = str(raw.when ?? raw.time ?? raw.at);
    // Prefer an explicit timezone arg, else the user's local tz from the client requestContext.
    let ctxTz: string | undefined;
    try {
      const v = context?.requestContext?.get?.('timezone');
      ctxTz = typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
      ctxTz = undefined;
    }
    const tz = str(raw.timezone) ?? ctxTz;
    const now = new Date();

    const existing = await getScheduledTask(tenantId);
    const pending = isPending(existing, now);

    if (action === 'status') {
      if (pending && existing) {
        return {
          status: 'scheduled' as const,
          runAt: existing.runAt,
          summaryText: `You have one scheduled task — runs ${describeRunAt(new Date(existing.runAt), existing.timezone || tz || 'Asia/Jakarta', now)}:\n${existing.prompt}`,
        };
      }
      return { status: 'none' as const, runAt: null, summaryText: 'You have no scheduled task right now.' };
    }

    if (action === 'cancel') {
      const canceled = pending ? await cancelScheduledTask(tenantId) : false;
      if (canceled) await cancelScheduledTaskRun(tenantId);
      return {
        status: canceled ? ('canceled' as const) : ('none' as const),
        runAt: null,
        summaryText: canceled ? 'Canceled your scheduled task.' : 'There was no scheduled task to cancel.',
      };
    }

    if (!prompt) {
      return { status: 'error' as const, runAt: null, summaryText: 'Tell me what you want me to do at that time.' };
    }

    // COMBINE: a task is already pending and we're not explicitly replacing → merge into it.
    if (pending && existing && action !== 'replace') {
      let runAt: Date | null = null;
      let resolvedTz: string | null = null;
      if (when) {
        const resolved = await resolveWhen(when, tenantId, now, tz);
        if (!resolved.at) return { status: 'error' as const, runAt: null, summaryText: resolved.error ?? 'I could not read that time.' };
        runAt = resolved.at;
        resolvedTz = resolved.timezone;
      }
      const combined = await combineScheduledTask(existing, prompt, runAt, resolvedTz);
      await cancelScheduledTaskRun(tenantId);
      const armed = await armScheduledTask(combined);
      const tzUsed = combined.timezone || tz || 'Asia/Jakarta';
      return {
        status: 'combined' as const,
        runAt: combined.runAt,
        summaryText: `You already had a task scheduled, so I added this to it (one scheduled task at a time). It now runs ${describeRunAt(new Date(combined.runAt), tzUsed, now)} and covers:\n${combined.prompt}${queueNote(armed)}`,
      };
    }

    // FRESH or REPLACE: need an explicit time.
    if (!when) {
      return { status: 'error' as const, runAt: null, summaryText: 'When should I run it? (e.g. "10am tomorrow", "in 2 hours")' };
    }
    const resolved = await resolveWhen(when, tenantId, now, tz);
    if (!resolved.at) return { status: 'error' as const, runAt: null, summaryText: resolved.error ?? 'I could not read that time.' };

    const saved = await setScheduledTask(tenantId, prompt, resolved.at, resolved.timezone);
    await cancelScheduledTaskRun(tenantId); // drop any superseded run before arming the new one
    const armed = await armScheduledTask(saved);
    return {
      status: pending && action === 'replace' ? ('replaced' as const) : ('scheduled' as const),
      runAt: saved.runAt,
      summaryText: `Done — I'll ${prompt.replace(/\.$/, '')} and message you ${describeRunAt(resolved.at, resolved.timezone, now)}.${queueNote(armed)}`,
    };
  },
});

/** Honest note when the scheduler couldn't confirm the queue (e.g. Inngest unreachable). The recovery
 *  sweep re-arms pending tasks, so it'll still fire once the scheduler is back — but say so plainly. */
function queueNote(armed: number | null): string {
  return armed == null
    ? " (Heads up: I couldn't confirm the scheduler queued it just now — it'll be picked up automatically once the scheduler reconnects.)"
    : '';
}
