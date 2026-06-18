// Sends a FORCED `insight/run.requested` event to Inngest (Cloud or dev) so the run-insight function
// runs immediately, bypassing the schedule validation — used to test the full Inngest → function loop.
//   npx tsx scripts/mock/trigger-insight-event.ts <tenantId>
import { loadLocalEnv } from './mock-env';

loadLocalEnv();
const tenantId = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!tenantId) {
  console.error('Usage: npx tsx scripts/mock/trigger-insight-event.ts <tenantId>');
  process.exit(1);
}

const { inngest } = await import('../../src/mastra/inngest/client');
const res = await inngest.send({
  name: 'insight/run.requested',
  data: { tenantId, subscribedKeys: null, force: true },
});
console.log('sent insight/run.requested (force)', JSON.stringify({ tenantId, ids: res.ids }));
process.exit(0);
