// Agent-callable: a quick profit & loss summary for a period from the ledger. Use when the user asks
// "how's my business doing / what's my profit / revenue this month". Requires advanced finance to be on
// (it reads posted journal entries).
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getFinanceSettings } from '../../integrations/finance/finance-settings-repo';
import { profitAndLoss } from '../../integrations/finance/reports-repo';

const paramsSchema = z.object({
  from: z.string().optional(), // YYYY-MM-DD
  to: z.string().optional(),
});

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

export const financialSummaryTool = createTool({
  id: 'financial-summary',
  strict: false,
  description:
    'Get a profit & loss summary (revenue, expenses, net profit, and the top accounts) for a date range from the accounting ledger. Defaults to the current month. Use for "how is my business doing", "what is my profit/revenue this month", "P&L". Requires accounting to be enabled.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: {} }, { input: { from: '2026-06-01', to: '2026-06-30' } }],
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    revenue: z.number().optional(),
    expense: z.number().optional(),
    net: z.number().optional(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const settings = await getFinanceSettings(tenantId).catch(() => ({ accountingEnabled: false, baseCurrency: 'IDR' }));
    if (!settings.accountingEnabled) {
      return { success: false, message: 'Accounting is off — enable it first to see a P&L (ask me to "enable accounting").' };
    }
    const parsed = paramsSchema.safeParse(input);
    const range = monthRange();
    const from = (parsed.success && parsed.data.from) || range.from;
    const to = (parsed.success && parsed.data.to) || range.to;
    try {
      const pl = await profitAndLoss(tenantId, from, to);
      const cur = settings.baseCurrency || 'IDR';
      const fmt = (v: number) => `${cur} ${v.toLocaleString('id-ID')}`;
      const top = pl.byAccount
        .slice()
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 5)
        .map((a) => `${a.name}: ${fmt(a.amount)}`)
        .join('; ');
      return {
        success: true,
        revenue: pl.revenue,
        expense: pl.expense,
        net: pl.net,
        message: `${from} to ${to} — Revenue ${fmt(pl.revenue)}, Expenses ${fmt(pl.expense)}, Net ${fmt(pl.net)}.${top ? ` Top: ${top}.` : ''}`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Could not compute the summary.' };
    }
  },
});
