// Agent-callable: produce a tax recap / planning document for a period from the ledger. A DRAFT for the
// user (and their tax person) — figures are traceable to journal entries, but it is not tax advice and
// should be reviewed before filing (e.g. into Coretax).
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getFinanceSettings } from '../../integrations/finance/finance-settings-repo';
import { taxRecap } from '../../integrations/finance/tax-recap';

const paramsSchema = z.object({ from: z.string().optional(), to: z.string().optional() });

function monthRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

export const generateTaxDocumentTool = createTool({
  id: 'generate-tax-document',
  strict: false,
  description:
    'Generate a tax recap / planning summary for a period (PPN output vs input + payable, and PPh withholding) from the accounting ledger. Use for "prepare my tax summary", "how much PPN do I owe this month", "tax planning document". Defaults to the current month. Requires accounting enabled. Output is a DRAFT to review before filing — not tax advice.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: {} }, { input: { from: '2026-06-01', to: '2026-06-30' } }],
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const settings = await getFinanceSettings(tenantId).catch(() => ({ accountingEnabled: false, baseCurrency: 'IDR' }));
    if (!settings.accountingEnabled) {
      return { success: false, message: 'Accounting is off — enable it first to prepare a tax recap.' };
    }
    const parsed = paramsSchema.safeParse(input);
    const range = monthRange();
    const from = (parsed.success && parsed.data.from) || range.from;
    const to = (parsed.success && parsed.data.to) || range.to;
    try {
      const r = await taxRecap(tenantId, from, to);
      const cur = settings.baseCurrency || 'IDR';
      const fmt = (v: number) => `${cur} ${v.toLocaleString('id-ID')}`;
      const wh = r.withholding.length ? r.withholding.map((w) => `${w.label} ${fmt(w.amount)}`).join(', ') : 'none';
      const lines = [
        `Tax recap ${from} → ${to}${r.npwp ? ` (NPWP ${r.npwp})` : ''}:`,
        `• PPN: output ${fmt(r.ppn.output)} − input ${fmt(r.ppn.input)} = payable ${fmt(r.ppn.payable)}`,
        `• PPh withholding payable: ${wh}`,
        'Draft from your ledger — review with your tax person before filing to Coretax.',
      ];
      return { success: true, message: lines.join('\n') };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Could not build the tax recap.' };
    }
  },
});
