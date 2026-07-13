// Agent-callable: schedule a FUTURE action, one-shot or recurring. The seller tells the agent to do
// something later ("send me a tax recap by 10am tomorrow") or on a repeating schedule ("check my
// TikTok orders every morning at 8am"), and at each fire time the FULL agent runs the instruction and
// posts the result into their Notifications chat. Up to MAX_ACTIVE_TASKS active tasks per tenant
// (one-shot + recurring combined). Supports listing, updating, and canceling a SPECIFIC task by id.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import {
  cancelScheduledTask,
  createRecurringScheduledTask,
  createScheduledTask,
  countActiveScheduledTasks,
  describeRecurrence,
  describeRunAt,
  getScheduledTaskById,
  listScheduledTasks,
  MAX_ACTIVE_TASKS,
  resolveRecurrence,
  resolveWhen,
  updateScheduledTask,
  type ScheduledTask,
} from '../../integrations/shared/scheduled-task-prefs';
import { armScheduledTask, cancelScheduledTaskRun } from '../../inngest/arm-scheduled-task';

const inputSchema = z.record(z.string(), z.unknown());

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function taskLine(t: ScheduledTask, tz: string): string {
  const when = t.kind === 'recurring' && t.localTime && t.daysOfWeek
    ? describeRecurrence({ localTime: t.localTime, daysOfWeek: t.daysOfWeek }, t.timezone || tz)
    : describeRunAt(new Date(t.runAt), t.timezone || tz, new Date());
  return `- [${t.id}] ${when} — ${t.prompt}`;
}

export const scheduleTaskTool = createTool({
  id: 'schedule-future-task',
  strict: false,
  description:
    `Schedule the agent to do something LATER — once or on a repeating schedule — and notify the user at each fire time. Use when the user asks you to do/send/check/remind something at a future time ("send me a tax recap by 10am tomorrow", "check my TikTok orders at 4pm") OR on a repeating schedule ("every morning at 8am", "daily at 9am", "every weekday", "every monday and thursday at 10am"). Up to ${MAX_ACTIVE_TASKS} active tasks per tenant (one-shot + recurring combined). \`action\`: set (default) | cancel | status. \`prompt\`: what to do at run time, phrased as an instruction to yourself. \`when\`: the time/schedule in the user's words — omit only for cancel/status. \`taskId\`: pass this (from a prior status call) to UPDATE an existing task's time/prompt instead of creating a new one, or to cancel one of several — omit taskId on cancel only when there's exactly one active task. status with no taskId lists every active task with its id and next-fire time.`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
    timezone: z.string().optional().describe("The user's local IANA timezone, if the client sent one."),
  }),
  inputSchema,
  inputExamples: [
    { input: { prompt: 'Generate my tax recap for this month and send it to me.', when: '10am tomorrow' } },
    { input: { prompt: 'Check my TikTok orders that still need to be processed.', when: 'every morning at 8am' } },
    { input: { action: 'status' } },
    { input: { action: 'cancel', taskId: 'abc-123' } },
  ],
  outputSchema: z.object({
    status: z.enum(['scheduled', 'updated', 'canceled', 'none', 'error']),
    taskId: z.string().nullable(),
    runAt: z.string().nullable(),
    summaryText: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const action = (str(raw.action) ?? 'set').toLowerCase();
    const prompt = str(raw.prompt ?? raw.instruction ?? raw.task);
    const when = str(raw.when ?? raw.time ?? raw.at);
    const taskId = str(raw.taskId ?? raw.id);
    // Prefer an explicit timezone arg, else the user's local tz from the client requestContext.
    let ctxTz: string | undefined;
    try {
      const v = context?.requestContext?.get?.('timezone');
      ctxTz = typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
      ctxTz = undefined;
    }
    const tz = str(raw.timezone) ?? ctxTz;
    const tzFallback = tz ?? 'Asia/Jakarta';
    const now = new Date();

    if (action === 'status') {
      const tasks = await listScheduledTasks(tenantId);
      if (tasks.length === 0) return { status: 'none' as const, taskId: null, runAt: null, summaryText: 'You have no scheduled tasks right now.' };
      const lines = tasks.map((t) => taskLine(t, tzFallback)).join('\n');
      return {
        status: 'scheduled' as const,
        taskId: null,
        runAt: tasks[0].runAt,
        summaryText: `You have ${tasks.length} scheduled task${tasks.length > 1 ? 's' : ''}:\n${lines}`,
      };
    }

    if (action === 'cancel') {
      let targetId = taskId;
      if (!targetId) {
        const tasks = await listScheduledTasks(tenantId);
        if (tasks.length === 0) return { status: 'none' as const, taskId: null, runAt: null, summaryText: 'There was no scheduled task to cancel.' };
        if (tasks.length > 1) {
          return {
            status: 'error' as const,
            taskId: null,
            runAt: null,
            summaryText: `You have ${tasks.length} scheduled tasks — which one? \n${tasks.map((t) => taskLine(t, tzFallback)).join('\n')}`,
          };
        }
        targetId = tasks[0].id;
      }
      const canceled = await cancelScheduledTask(tenantId, targetId);
      if (canceled) await cancelScheduledTaskRun(tenantId, targetId);
      return {
        status: canceled ? ('canceled' as const) : ('none' as const),
        taskId: canceled ? targetId : null,
        runAt: null,
        summaryText: canceled ? 'Canceled that scheduled task.' : 'There was no matching scheduled task to cancel.',
      };
    }

    if (!prompt) {
      return { status: 'error' as const, taskId: null, runAt: null, summaryText: 'Tell me what you want me to do at that time.' };
    }

    // UPDATE an existing task (agent already has its id from a prior status call).
    if (taskId) {
      const existing = await getScheduledTaskById(taskId);
      if (!existing || existing.tenantId !== tenantId) {
        return { status: 'error' as const, taskId: null, runAt: null, summaryText: "I couldn't find that scheduled task anymore." };
      }
      let recurrence = null as Awaited<ReturnType<typeof resolveRecurrence>>;
      let oneShot: Date | null = null;
      let resolvedTz: string | null = null;
      if (when) {
        recurrence = await resolveRecurrence(when, tenantId, tz);
        if (!recurrence) {
          const resolved = await resolveWhen(when, tenantId, now, tz);
          if (!resolved.at) return { status: 'error' as const, taskId: null, runAt: null, summaryText: resolved.error ?? 'I could not read that time.' };
          oneShot = resolved.at;
          resolvedTz = resolved.timezone;
        } else {
          resolvedTz = recurrence.timezone;
        }
      }
      const updated = await updateScheduledTask(tenantId, taskId, {
        prompt,
        runAt: oneShot ?? undefined,
        recurrence,
        timezone: resolvedTz,
      });
      if (!updated) return { status: 'error' as const, taskId: null, runAt: null, summaryText: "I couldn't find that scheduled task anymore." };
      await cancelScheduledTaskRun(tenantId, taskId);
      const armed = await armScheduledTask(updated);
      const tzUsed = updated.timezone || tzFallback;
      const whenLabel = updated.kind === 'recurring' && updated.localTime && updated.daysOfWeek
        ? describeRecurrence({ localTime: updated.localTime, daysOfWeek: updated.daysOfWeek }, tzUsed)
        : describeRunAt(new Date(updated.runAt), tzUsed, now);
      return {
        status: 'updated' as const,
        taskId: updated.id,
        runAt: updated.runAt,
        summaryText: `Updated — I'll ${updated.prompt.replace(/\.$/, '')}, ${whenLabel}.${queueNote(armed)}`,
      };
    }

    // FRESH task: need an explicit time/schedule, and must be under the cap.
    if (!when) {
      return { status: 'error' as const, taskId: null, runAt: null, summaryText: 'When should I run it? (e.g. "10am tomorrow", "every morning at 8am")' };
    }
    const activeCount = await countActiveScheduledTasks(tenantId);
    if (activeCount >= MAX_ACTIVE_TASKS) {
      return {
        status: 'error' as const,
        taskId: null,
        runAt: null,
        summaryText: `You already have ${MAX_ACTIVE_TASKS} scheduled tasks, the most I can hold at once — cancel one first (ask me for your list) before adding another.`,
      };
    }

    const recurrence = await resolveRecurrence(when, tenantId, tz);
    if (recurrence) {
      const saved = await createRecurringScheduledTask(tenantId, prompt, recurrence);
      await cancelScheduledTaskRun(tenantId, saved.id);
      const armed = await armScheduledTask(saved);
      const whenLabel = describeRecurrence({ localTime: recurrence.localTime, daysOfWeek: recurrence.daysOfWeek }, recurrence.timezone);
      return {
        status: 'scheduled' as const,
        taskId: saved.id,
        runAt: saved.runAt,
        summaryText: `Done — I'll ${prompt.replace(/\.$/, '')}, ${whenLabel}.${queueNote(armed)}`,
      };
    }

    const resolved = await resolveWhen(when, tenantId, now, tz);
    if (!resolved.at) return { status: 'error' as const, taskId: null, runAt: null, summaryText: resolved.error ?? 'I could not read that time.' };

    const saved = await createScheduledTask(tenantId, prompt, resolved.at, resolved.timezone);
    const armed = await armScheduledTask(saved);
    return {
      status: 'scheduled' as const,
      taskId: saved.id,
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
