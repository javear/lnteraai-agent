// Agent-callable "analyze my business now" — runs the seller's subscribed insights immediately and
// posts the analysis + charts into their Active Agent chat (same delivery as the scheduled run, no
// Inngest). This is the agent's capability to generate the charted analysis on demand.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getInsightSchedule } from '../../integrations/shared/insight-schedule-prefs';

export const runInsightsNowTool = createTool({
  id: 'run-business-analysis',
  strict: false,
  description:
    'Run the seller\'s business analysis NOW and post the insights + charts into their Active Agent chat. Use when the user asks to analyze their business, generate a report/insights now, or "how is my business doing today". Pulls live Shopee/TikTok data, computes metrics (unprocessed orders, cancellation rate, restock alerts, …) and delivers charts.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: {} }],
  outputSchema: z.object({
    status: z.string(),
    insightsReported: z.number(),
    message: z.string(),
  }),
  execute: async (_input, context) => {
    const tenantId = requireTenantContext(context);
    const schedule = await getInsightSchedule(tenantId);
    const keys = schedule?.subscribedKeys ?? null; // null = all default-on insights

    // Dynamic import breaks the static cycle (agent → tools barrel → this tool → insight-notifier →
    // web-delivery → general-agent).
    const { runAndNotifyInsights } = await import('../../active-mode/insight-notifier');
    const r = await runAndNotifyInsights(tenantId, keys);

    const message =
      r.status === 'no_connection'
        ? 'No connected marketplace yet — connect Shopee or TikTok Shop first.'
        : r.status === 'no_insights'
          ? 'No insights are selected to run.'
          : r.status === 'no_data'
            ? "Ran the analysis, but there isn't enough recent data to report yet."
            : `Posted your business analysis (${r.insightsReported} insight${r.insightsReported === 1 ? '' : 's'}) to your Active Agent chat.`;
    return { status: r.status, insightsReported: r.insightsReported, message };
  },
});
