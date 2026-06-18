// Sends an `insight/run.requested` event to Inngest (Cloud or dev) so the run-insight function is
// invoked exactly as the dispatcher cron would. Used to test the full Inngest → function loop.
//   npx tsx scripts/mock/trigger-insight-event.ts <tenantId>
import { loadLocalEnv } from './mock-env';

loadLocalEnv();
const tenantId = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!tenantId) {
  console.error('Usage: npx tsx scripts/mock/trigger-insight-event.ts <tenantId>');
  process.exit(1);
}

const { inngest } = await import('../../src/mastra/inngest/client');
const slotKey = `manual-${Date.now()}`;
const res = await inngest.send({
  name: 'insight/run.requested',
  data: { tenantId, subscribedKeys: null, slotKey },
});
console.log('sent insight/run.requested', JSON.stringify({ tenantId, slotKey, ids: res.ids }));
process.exit(0);
