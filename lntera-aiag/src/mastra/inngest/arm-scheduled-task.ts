// Arm one scheduled task (one-shot OR recurring — both use `run_at` as "the next fire time") as a
// single delayed Inngest event (`ts` = the fire time, so Inngest starts the run then). When it fires,
// run-scheduled-task validates against the DB (status + run_at) and runs the agent; a recurring task
// then advances to its next occurrence and re-arms itself (see run-scheduled-task.ts), a self-
// rescheduling chain exactly like the Insight schedule's, so no separate recurring-arm function is
// needed here. Idempotency: the event id is taskId + the fire MINUTE, so duplicate arms (tool save +
// recovery sweep) dedupe to one; a time change yields a new id, and the stale event no-ops on fire
// (run_at mismatch). The DB `status` is the AUTHORITY that prevents a double-run. A send failure never
// throws — the recovery sweep re-arms once Inngest is reachable again.
import { inngest } from './client';
import { logErrorBrief } from '../logger/compact-error';
import type { ScheduledTask } from '../integrations/shared/scheduled-task-prefs';

export const SCHEDULED_TASK_RUN_EVENT = 'task/run.requested';
export const SCHEDULED_TASK_CANCEL_EVENT = 'task/run.canceled';

/** Cancel ONE task's pending run (sent on cancel/update so the superseded run drops — scoped by
 *  taskId, not tenantId, since a tenant can now have several tasks in flight at once). */
export async function cancelScheduledTaskRun(tenantId: string, taskId: string): Promise<void> {
  try {
    await inngest.send({ name: SCHEDULED_TASK_CANCEL_EVENT, data: { tenantId, taskId } });
  } catch (err) {
    logErrorBrief(`[task] cancelScheduledTaskRun send failed tenant=${tenantId} task=${taskId}`, err);
  }
}

/** Arm (or re-arm) the task's run at its fire time. Idempotent; no-op for non-scheduled tasks. */
export async function armScheduledTask(task: ScheduledTask): Promise<number | null> {
  if (task.status !== 'scheduled') return null;
  const ts = new Date(task.runAt).getTime();
  if (!Number.isFinite(ts)) return null;
  try {
    await inngest.send({
      name: SCHEDULED_TASK_RUN_EVENT,
      ts, // future ts ⇒ Inngest schedules the run for this instant
      id: `${task.id}-${Math.floor(ts / 60000)}`, // taskId + fire-minute ⇒ dedupe normal, new id on edit
      data: { tenantId: task.tenantId, taskId: task.id, targetTs: ts },
    });
  } catch (err) {
    logErrorBrief(`[task] armScheduledTask send failed tenant=${task.tenantId} (sweep will recover)`, err);
    return null;
  }
  return ts;
}
