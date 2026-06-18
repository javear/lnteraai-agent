// Recovery backstop for the event-driven scheduler. Every 15 min it (re)arms the next run for EVERY
// enabled schedule. Arming is idempotent (occurrence-minute event id), so this is cheap insurance — it
// bootstraps schedules that have no chain yet (created before this system, or whose arm send failed),
// and re-arms any chain dropped by an app/Inngest outage (a missed run re-arms at ts=now → fires on
// recovery). The PRIMARY scheduling path is the per-tenant self-rescheduling chain in run-insight;
// this guarantees no schedule is ever orphaned. ~96 cheap runs/day (vs a minutely poll's 1,440).
import { inngest } from '../client';
import { armNextRun } from '../arm-insight';
import { getEnabledSchedulesForArming } from '../../integrations/shared/insight-schedule-prefs';

export const insightArmSweepFn = inngest.createFunction(
  { id: 'insight-arm-sweep', triggers: [{ cron: '*/15 * * * *' }] },
  async ({ step }) => {
    const armed = await step.run('arm-enabled', async () => {
      const schedules = await getEnabledSchedulesForArming();
      let n = 0;
      for (const s of schedules) {
        try {
          await armNextRun(s.tenantId, s.schedule, s.tenantTz);
          n++;
        } catch {
          /* a single tenant's arm failure must not abort the sweep */
        }
      }
      return n;
    });
    return { armed };
  },
);
