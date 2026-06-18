// Runs ONE tenant's scheduled analysis when its armed event fires, then re-arms the next occurrence
// (the self-rescheduling chain). Robustness:
//  - DB `last_run_at` is the authority → ranOnLocalDay prevents a double-run no matter how many events
//    arrive (chain + sweep + a retried/duplicate send).
//  - occurrenceMatches rejects a STALE event whose time was edited away (the new chain already covers it).
//  - It ALWAYS re-arms at the end, so the chain survives every branch (skipped, no-data, delivered).
//  - Inngest `retries` cover a brief app outage (it can't reach our SDK → retried when we're back);
//    a longer Inngest/app outage is recovered by the arm-sweep cron (re-arms at ts=now → fires on recovery).
//  - `force` (manual triggers) bypasses validation + the once/day guard.
import { inngest } from '../client';
import { armNextRun } from '../arm-insight';
import {
  getInsightSchedule,
  markScheduleRan,
  occurrenceMatches,
  ranOnLocalDay,
  resolveTenantTimezone,
} from '../../integrations/shared/insight-schedule-prefs';
import { runTenantInsights } from '../../insights/engine';
import { notifyTenantOfInsights } from '../../active-mode/insight-notifier';

interface RunInsightEventData {
  tenantId: string;
  scheduleId?: string;
  targetTs?: number;
  subscribedKeys?: string[] | null;
  force?: boolean;
}

export const runInsightFn = inngest.createFunction(
  {
    id: 'run-insight',
    // Under the free-tier 5: ≤4 tenants at once, and a single tenant never overlaps itself.
    concurrency: [{ limit: 4 }, { key: 'event.data.tenantId', limit: 1 }],
    retries: 4,
    triggers: [{ event: 'insight/run.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as RunInsightEventData;
    const tenantId = data.tenantId;
    const force = data.force === true;

    // 1. Validate + run + deliver in one memoized step (so a later step's retry never re-delivers).
    const outcome = await step.run('run-and-notify', async () => {
      const schedule = await getInsightSchedule(tenantId);
      if (!schedule || !schedule.enabled) return { ran: false as const, reason: 'disabled' };
      const tenantTz = await resolveTenantTimezone(tenantId);
      if (!force) {
        if (typeof data.targetTs === 'number' && !occurrenceMatches(schedule, data.targetTs, tenantTz)) {
          return { ran: false as const, reason: 'stale-occurrence' }; // time edited; the new chain covers it
        }
        if (ranOnLocalDay(schedule, new Date(), tenantTz)) {
          return { ran: false as const, reason: 'already-ran-today' }; // double-run guard (authority)
        }
      }
      const run = await runTenantInsights(tenantId, data.subscribedKeys ?? schedule.subscribedKeys ?? null);
      if (run.status !== 'no_connection' && run.status !== 'no_insights') {
        await notifyTenantOfInsights(tenantId, run);
      }
      return { ran: true as const, scheduleId: schedule.id, status: run.status };
    });

    // 2. Mark the local day done so the chain advances to the NEXT occurrence (not re-run today).
    if (outcome.ran) {
      await step.run('mark-ran', () => markScheduleRan(outcome.scheduleId, new Date()));
    }

    // 3. ALWAYS re-arm the next occurrence (idempotent) so the chain survives every path.
    await step.run('arm-next', () => armNextRun(tenantId));

    return outcome;
  },
);
