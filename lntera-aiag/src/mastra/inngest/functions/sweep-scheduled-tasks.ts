// Recovery backstop for one-shot scheduled tasks. Every 15 min it re-arms every still-'scheduled' task
// (idempotent via the taskId+fire-minute event id), so a task whose original arm send failed, or whose
// chain was lost to an app/Inngest outage, still fires. A task that already fired is terminal
// (done/error/canceled) and is skipped — so this never loops a finished task. The PRIMARY path is the
// delayed event armed at creation time; this is cheap insurance.
import { inngest } from '../client';
import { armScheduledTask } from '../arm-scheduled-task';
import { getScheduledTasksForArming } from '../../integrations/shared/scheduled-task-prefs';

export const scheduledTaskSweepFn = inngest.createFunction(
  { id: 'scheduled-task-sweep', triggers: [{ cron: '*/15 * * * *' }] },
  async ({ step }) => {
    const armed = await step.run('arm-scheduled', async () => {
      const tasks = await getScheduledTasksForArming();
      let n = 0;
      for (const t of tasks) {
        try {
          await armScheduledTask(t.task);
          n++;
        } catch {
          /* a single task's arm failure must not abort the sweep */
        }
      }
      return n;
    });
    return { armed };
  },
);
