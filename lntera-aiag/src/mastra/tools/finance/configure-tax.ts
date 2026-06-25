// Agent-callable: set or read the tenant's tax configuration. The agent can interview the user
// ("are you PPN-registered? what's your NPWP? do you withhold PPh 23 on services?") and persist it.
// Tax rules differ per business, so nothing is hardcoded.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getTaxConfig, setTaxConfig, type WithholdingRule } from '../../integrations/finance/tax-config-repo';

const withholdingSchema = z.object({ type: z.string(), rate: z.number().optional() });

const paramsSchema = z.object({
  read: z.boolean().optional(), // true → just return the current config
  npwp: z.string().optional(),
  ppnEnabled: z.boolean().optional(),
  ppnRate: z.number().optional(),
  withholding: z.array(withholdingSchema).optional(),
});

export const configureTaxTool = createTool({
  id: 'configure-tax',
  strict: false,
  description:
    'Set or read the business\'s tax profile (used for tax recaps + filing prep). Use when the user describes their taxes — "we\'re PPN-registered at 11%", "our NPWP is …", "we withhold PPh 23 on services" — or asks what tax setup is saved (pass read:true). Fields: npwp, ppnEnabled, ppnRate (percent), withholding [{type:"PPh23",rate:2}]. Ask the user for anything you don\'t know; do not invent rates or NPWP.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [
    { input: { npwp: '01.234.567.8-901.000', ppnEnabled: true, ppnRate: 11, withholding: [{ type: 'PPh23', rate: 2 }] } },
    { input: { read: true } },
  ],
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, message: 'Tell me the tax details to save (NPWP, PPN, withholding) or pass read:true.' };
    }
    const p = parsed.data;
    try {
      if (p.read) {
        const c = await getTaxConfig(tenantId);
        const wh = (c.config.withholding ?? []).map((w) => `${w.type}${w.rate != null ? ` ${w.rate}%` : ''}`).join(', ');
        return {
          success: true,
          message: `Tax profile — NPWP: ${c.npwp ?? 'not set'}; PPN: ${c.config.ppnEnabled ? `${c.config.ppnRate ?? '?'}%` : 'off'}; Withholding: ${wh || 'none'}.`,
        };
      }
      const config: Record<string, unknown> = {};
      if (p.ppnEnabled !== undefined) config.ppnEnabled = p.ppnEnabled;
      if (p.ppnRate !== undefined) config.ppnRate = p.ppnRate;
      if (p.withholding !== undefined) config.withholding = p.withholding as WithholdingRule[];
      const saved = await setTaxConfig(tenantId, { ...(p.npwp !== undefined ? { npwp: p.npwp } : {}), config });
      const wh = (saved.config.withholding ?? []).map((w) => `${w.type}${w.rate != null ? ` ${w.rate}%` : ''}`).join(', ');
      return {
        success: true,
        message: `Saved tax profile — NPWP: ${saved.npwp ?? 'not set'}; PPN: ${saved.config.ppnEnabled ? `${saved.config.ppnRate ?? '?'}%` : 'off'}; Withholding: ${wh || 'none'}.`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Could not update the tax profile.' };
    }
  },
});
