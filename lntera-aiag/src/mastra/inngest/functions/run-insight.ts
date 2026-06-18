// The per-tenant scheduled analysis. ONE execution per scheduled slot: the engine prefetches once
// and loops all subscribed insights + shops inside this single run (no per-insight fan-out).
// Concurrency: global 4 (under free-tier 5) + per-tenant 1 (a tenant never runs two at once; overlaps
// queue). Idempotency on slotKey prevents a slot ever running twice. Beyond the limit, Inngest queues
// and serves later automatically.
import { inngest } from '../client';
import { runAndNotifyInsights } from '../../active-mode/insight-notifier';

interface RunInsightEventData {
  tenantId: string;
  scheduleId?: string;
  slotKey?: string;
  subscribedKeys?: string[] | null;
}

export const runInsightFn = inngest.createFunction(
  {
    id: 'run-insight',
    concurrency: [{ limit: 4 }, { key: 'event.data.tenantId', limit: 1 }],
    idempotency: 'event.data.slotKey',
    retries: 2,
    triggers: [{ event: 'insight/run.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as RunInsightEventData;
    return step.run('run-and-notify', () =>
      runAndNotifyInsights(data.tenantId, data.subscribedKeys ?? null),
    );
  },
);
