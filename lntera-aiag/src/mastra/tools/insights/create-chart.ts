// Agent-callable chart renderer. The LLM passes an explicit chart spec (computed from data it already
// fetched via search-orders / search-products / etc.) and we deliver it into the seller's Active Agent
// chat via the SAME stack as scheduled insights (persist + realtime + push → InsightChart render). This
// is what lets a normal chat request like "chart my orders for the last 7 days" actually draw a chart,
// instead of charts only existing for the scheduled business analysis.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import type { ChartSpec } from '../../insights/types';

const seriesSchema = z.object({
  name: z.string().optional(),
  data: z.array(z.number()).min(1),
});

const createChartParamsSchema = z.object({
  type: z.enum(['bar', 'line', 'donut']),
  title: z.string().min(1),
  unit: z.string().optional(),
  labels: z.array(z.string().min(1)).min(1),
  series: z.array(seriesSchema).min(1),
  caption: z.string().optional(),
});

export const createChartTool = createTool({
  id: 'create-chart',
  strict: false,
  description:
    'Draw a chart in the user\'s chat from data YOU have already computed (e.g. from search-orders / search-products). Use whenever the user asks to chart / plot / graph / visualize something. `type`: bar | line | donut. `labels` are the x-axis / category labels; `series` is one or more { name, data } where each `data[]` aligns 1:1 with `labels` (donut uses a single series). `unit` (e.g. "orders", "MYR", "%") is for tooltips. Pass ONLY real numbers you actually computed — never invent figures; if you lack the data, fetch it first or say so. `caption` becomes the accompanying message.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [
    {
      input: {
        type: 'bar',
        title: 'Orders per day (last 7 days)',
        unit: 'orders',
        labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        series: [{ name: 'Orders', data: [3, 5, 2, 8, 6, 9, 4] }],
        caption: 'Here are your orders per day over the last week.',
      },
    },
    {
      input: {
        type: 'donut',
        title: 'Revenue by platform',
        unit: 'MYR',
        labels: ['Shopee', 'TikTok'],
        series: [{ data: [1820, 1140] }],
      },
    },
  ],
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = createChartParamsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        message: `Invalid chart input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const p = parsed.data;

    // Every series must align 1:1 with the labels, or the chart renders nonsense.
    for (const s of p.series) {
      if (s.data.length !== p.labels.length) {
        return {
          success: false,
          message: `Series "${s.name ?? 'series'}" has ${s.data.length} value(s) but there are ${p.labels.length} label(s) — they must match.`,
        };
      }
    }
    if (p.type === 'donut' && p.series.length > 1) {
      return { success: false, message: 'A donut chart takes a single series; pass one { data } aligned to labels.' };
    }

    const chart: ChartSpec = {
      type: p.type,
      title: p.title,
      unit: p.unit,
      labels: p.labels,
      series: p.series.map((s) => ({ name: s.name, data: s.data })),
    };

    // Dynamic import avoids the static cycle (agent → tools barrel → this tool → web-delivery → agent).
    const { deliverTenantWebNotification } = await import('../../active-mode/web-delivery');
    await deliverTenantWebNotification({
      tenantId,
      text: p.caption?.trim() || p.title,
      heading: '📊 Chart',
      kind: 'insight',
      deterministic: true,
      charts: [chart],
    });

    return { success: true, message: `Rendered "${p.title}" in your chat.` };
  },
});
