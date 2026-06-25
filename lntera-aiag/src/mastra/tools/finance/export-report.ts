// Agent-callable: generate a downloadable report file and return a (time-limited) download link. Use when
// the user asks to "download / export / send me" a trial balance, P&L, journal, or tax recap as a file.
// Requires accounting enabled. The link expires in ~1 hour.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { getFinanceSettings } from '../../integrations/finance/finance-settings-repo';
import { buildReportFile, type ReportType, type ReportFormat } from '../../integrations/finance/report-files';

const REPORTS = ['trial-balance', 'profit-loss', 'journal', 'tax-recap'] as const;
const FORMATS = ['xlsx', 'pdf', 'csv'] as const;

const paramsSchema = z.object({
  report: z.enum(REPORTS),
  format: z.enum(FORMATS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const exportReportTool = createTool({
  id: 'export-report',
  strict: false,
  description:
    'Generate a DOWNLOADABLE report file (Excel XLSX, PDF, or CSV) and return a download link. Use for "download/export/send me my trial balance / profit & loss / journal / tax recap (as excel/xlsx/pdf/csv)". `report`: trial-balance | profit-loss | journal | tax-recap. `format`: xlsx (default) | pdf | csv. Optional from/to (YYYY-MM-DD). Requires accounting enabled; the link is valid ~1 hour.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [
    { input: { report: 'trial-balance', format: 'xlsx' } },
    { input: { report: 'profit-loss', format: 'pdf', from: '2026-06-01', to: '2026-06-30' } },
  ],
  outputSchema: z.object({ success: z.boolean(), message: z.string(), url: z.string().optional() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const settings = await getFinanceSettings(tenantId).catch(() => ({ accountingEnabled: false }));
    if (!settings.accountingEnabled) {
      return { success: false, message: 'Accounting is off — enable it first to export reports.' };
    }
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, message: `Pick a report: ${REPORTS.join(', ')}.` };
    }
    const { report, from, to } = parsed.data;
    const format = (parsed.data.format ?? 'xlsx') as ReportFormat;
    const res = await buildReportFile(tenantId, report as ReportType, format, from, to);
    if ('error' in res) return { success: false, message: res.error };
    return {
      success: true,
      url: res.url,
      message: `Your ${report} (${format.toUpperCase()}) is ready: [${res.filename}](${res.url}) (link valid ~1 hour).`,
    };
  },
});
