// Dispatcher cron: every minute, find tenants whose chosen local time has arrived today and fan out
// one `insight/run.requested` event each. The event `id` (scheduleId:slotKey, slotKey = per local
// day) is send-side idempotent — a duplicate tick can't enqueue the same day twice. We mark each
// schedule as run so the once/day guard holds even if the dispatcher overlaps.
// NOTE: minutely keeps to-the-minute precision for user-chosen times. On a constrained Inngest plan,
// coarsen to e.g. `*/5 * * * *` (the at/after-time logic still fires within that window).
import { inngest } from '../client';
import { listDueSchedules, markScheduleRan } from '../../integrations/shared/insight-schedule-prefs';

export const dispatchInsightsFn = inngest.createFunction(
  { id: 'dispatch-insights', triggers: [{ cron: '* * * * *' }] },
  async ({ step }) => {
    const now = new Date();
    const due = await step.run('list-due', () => listDueSchedules(now));

    for (const d of due) {
      await step.sendEvent(`emit-${d.scheduleId}`, {
        name: 'insight/run.requested',
        data: {
          tenantId: d.tenantId,
          scheduleId: d.scheduleId,
          slotKey: d.slotKey,
          subscribedKeys: d.subscribedKeys,
        },
        id: `${d.scheduleId}:${d.slotKey}`,
      });
      await step.run(`mark-${d.scheduleId}`, () => markScheduleRan(d.scheduleId, now));
    }

    return { dispatched: due.length };
  },
);
