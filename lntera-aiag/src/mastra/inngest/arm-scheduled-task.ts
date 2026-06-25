// Arm a tenant's one-shot scheduled task as a single delayed Inngest event (`ts` = the fire time, so
// Inngest starts the run then). When it fires, run-scheduled-task validates against the DB (status +
// run_at) and runs the agent. Idempotency: the event id is taskId + the fire MINUTE, so duplicate arms
// (tool save + recovery sweep) dedupe to one; a time change yields a new id, and the stale event no-ops
// on fire (run_at mismatch). The DB `status` is the AUTHORITY that prevents a double-run. A send failure
// never throws — the recovery sweep re-arms once Inngest is reachable again.
import { inngest } from './client';
import { logErrorBrief } from '../logger/compact-error';
import type { ScheduledTask } from '../integrations/shared/scheduled-task-prefs';

export const SCHEDULED_TASK_RUN_EVENT = 'task/run.requested';
export const SCHEDULED_TASK_CANCEL_EVENT = 'task/run.canceled';

/** Cancel a tenant's pending scheduled-task run (sent on cancel/replace so the superseded run drops). */
export async function cancelScheduledTaskRun(tenantId: string): Promise<void> {
  try {
    await inngest.send({ name: SCHEDULED_TASK_CANCEL_EVENT, data: { tenantId } });
  } catch (err) {
    logErrorBrief(`[task] cancelScheduledTaskRun send failed tenant=${tenantId}`, err);
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
