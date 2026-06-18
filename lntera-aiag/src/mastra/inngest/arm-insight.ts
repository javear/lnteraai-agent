// Arms a tenant's NEXT run as a single delayed Inngest event (`ts` = next run time, so Inngest starts
// the run then). When it fires, run-insight validates against the DB, runs, and re-arms the following
// occurrence — a self-rescheduling chain that needs no minutely poll.
//
// Idempotency & recovery: the event id is the occurrence MINUTE, so duplicate arms (chain + save +
// sweep) dedupe to one, while a missed/overdue run re-arms at a fresh minute (nextRunFor returns
// `now`) and therefore re-fires. The DB `last_run_at` guard in run-insight is the AUTHORITY that
// prevents double-runs regardless of how many events arrive. A send failure (Inngest down) never
// throws — the periodic arm sweep re-arms once Inngest recovers.
import { inngest } from './client';
import { logErrorBrief } from '../logger/compact-error';
import {
  getInsightSchedule,
  nextRunFor,
  resolveTenantTimezone,
  type ResolvedInsightSchedule,
} from '../integrations/shared/insight-schedule-prefs';

export const INSIGHT_RUN_EVENT = 'insight/run.requested';
export const INSIGHT_CANCEL_EVENT = 'insight/run.canceled';

/**
 * Cancel a tenant's pending (scheduled/queued) run-insight runs. Sent on schedule edit/disable so the
 * superseded run is dropped instead of lingering in the queue until it fires and no-ops. run-insight
 * cancels on this via `cancelOn` (matched by data.tenantId). Best-effort — validate-on-fire is the
 * safety net, so a missed cancel only means one harmless no-op run.
 */
export async function cancelTenantRuns(tenantId: string): Promise<void> {
  try {
    await inngest.send({ name: INSIGHT_CANCEL_EVENT, data: { tenantId } });
  } catch (err) {
    logErrorBrief(`[insights] cancelTenantRuns send failed tenant=${tenantId}`, err);
  }
}

/**
 * Arm (or re-arm) the tenant's next scheduled run. Idempotent; returns the armed timestamp (ms) or
 * null when the schedule is disabled / has no upcoming run / Inngest was unreachable.
 */
export async function armNextRun(
  tenantId: string,
  scheduleArg?: ResolvedInsightSchedule | null,
  tenantTzArg?: string | null,
): Promise<number | null> {
  const schedule = scheduleArg ?? (await getInsightSchedule(tenantId));
  if (!schedule || !schedule.enabled) return null;
  const tenantTz = tenantTzArg !== undefined ? tenantTzArg : await resolveTenantTimezone(tenantId);
  const next = nextRunFor(schedule, new Date(), tenantTz);
  if (!next.at) return null;

  const ts = next.at.getTime();
  try {
    await inngest.send({
      name: INSIGHT_RUN_EVENT,
      ts, // future ts ⇒ Inngest schedules the run for this time (≤7 days out, even for weekly)
      id: `${schedule.id}-${Math.floor(ts / 60000)}`, // occurrence-minute ⇒ dedupe normal, allow recovery
      data: {
        tenantId,
        scheduleId: schedule.id,
        targetTs: ts,
        subscribedKeys: schedule.subscribedKeys,
      },
    });
  } catch (err) {
    logErrorBrief(`[insights] armNextRun send failed tenant=${tenantId} (sweep will recover)`, err);
    return null;
  }
  return ts;
}
