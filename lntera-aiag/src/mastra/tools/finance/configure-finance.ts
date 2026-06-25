// Agent-callable: turn the advanced-finance (accounting ledger + tax) feature on or off for the tenant.
// Transaction recording is always on regardless; this only gates the double-entry ledger/reports/tax.
// Enabling seeds the default chart of accounts + posting rules and backfill-posts existing transactions.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getFinanceSettings, setAccountingEnabled } from '../../integrations/finance/finance-settings-repo';
import { backfillUnposted } from '../../integrations/finance/posting-engine';

const paramsSchema = z.object({
  enable: z.boolean(),
});

export const configureFinanceTool = createTool({
  id: 'configure-finance',
  strict: false,
  description:
    'Turn the advanced accounting/finance ledger ON or OFF for this business. Use when the user wants to "enable accounting / bookkeeping / the ledger", "start tracking my books", or "turn off accounting". Transaction recording stays on regardless — this only controls the double-entry ledger, trial balance, and tax features. Enabling sets up a default (editable) chart of accounts and back-posts existing transactions.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { enable: true } }, { input: { enable: false } }],
  outputSchema: z.object({ success: z.boolean(), enabled: z.boolean(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, enabled: false, message: 'Tell me whether to enable or disable accounting.' };
    }
    try {
      await setAccountingEnabled(tenantId, parsed.data.enable);
      if (parsed.data.enable) {
        const { posted } = await backfillUnposted(tenantId);
        return {
          success: true,
          enabled: true,
          message: `Accounting is on. Seeded a default chart of accounts${posted > 0 ? ` and posted ${posted} existing transaction(s) to the ledger` : ''}. You can rename/renumber accounts anytime.`,
        };
      }
      return { success: true, enabled: false, message: 'Accounting is off. Transactions are still being recorded; the ledger is paused.' };
    } catch (err) {
      const settings = await getFinanceSettings(tenantId).catch(() => ({ accountingEnabled: false }));
      return { success: false, enabled: settings.accountingEnabled, message: err instanceof Error ? err.message : 'Could not change the finance setting.' };
    }
  },
});
