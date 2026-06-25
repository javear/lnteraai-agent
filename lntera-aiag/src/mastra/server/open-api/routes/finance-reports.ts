import { registerApiRoute } from '@mastra/core/server';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { trialBalance, generalLedger, profitAndLoss, journalExportRows } from '../../../integrations/finance/reports-repo';
import { taxRecap } from '../../../integrations/finance/tax-recap';

type Ctx = OpenApiHandlerContext & { req: { param: (n: string) => string | undefined; query: (n: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const q = (c: Ctx, k: string): string | undefined => {
  const v = c.req.query(k);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** GET /svc/v1/finance/trial-balance?from&to — Neraca Saldo. */
const trialBalanceRoute = registerApiRoute(`${OPEN_API_PREFIX}/finance/trial-balance`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Trial balance (Neraca Saldo)', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    try {
      return c.json({ rows: await trialBalance(auth.tenantId, q(c, 'from'), q(c, 'to')) });
    } catch (err) {
      return openApiJsonError(c, 400, 'query_failed', err instanceof Error ? err.message : 'Failed.');
    }
  },
});

/** GET /svc/v1/finance/ledger?account&from&to — general ledger for one account code. */
const ledgerRoute = registerApiRoute(`${OPEN_API_PREFIX}/finance/ledger`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'General ledger for an account', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const account = q(c, 'account');
    if (!account) return openApiJsonError(c, 400, 'bad_request', 'account (code) is required.');
    try {
      return c.json({ account, lines: await generalLedger(auth.tenantId, account, q(c, 'from'), q(c, 'to')) });
    } catch (err) {
      return openApiJsonError(c, 400, 'query_failed', err instanceof Error ? err.message : 'Failed.');
    }
  },
});

/** GET /svc/v1/finance/profit-loss?from&to — simple P&L. */
const profitLossRoute = registerApiRoute(`${OPEN_API_PREFIX}/finance/profit-loss`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Profit & loss summary', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    try {
      return c.json(await profitAndLoss(auth.tenantId, q(c, 'from'), q(c, 'to')));
    } catch (err) {
      return openApiJsonError(c, 400, 'query_failed', err instanceof Error ? err.message : 'Failed.');
    }
  },
});

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /svc/v1/finance/export?from&to — journal lines as CSV (OWL-style columns). */
const exportRoute = registerApiRoute(`${OPEN_API_PREFIX}/finance/export`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Export journal entries as CSV', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'CSV' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const rows = await journalExportRows(auth.tenantId, q(c, 'from'), q(c, 'to'));
    const header = ['Tanggal', 'No Jurnal', 'Nomor Akun', 'Nama Akun', 'Keterangan', 'Debet', 'Kredit'];
    const body = rows.map((r) =>
      [r.date, r.entry_no, r.account_code, r.account_name, r.description, r.debit, r.credit].map(csvCell).join(','),
    );
    const csv = [header.join(','), ...body].join('\n');
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="journal-export.csv"',
      },
    });
  },
});

/** GET /svc/v1/finance/tax-recap?from&to — PPN + PPh withholding recap from the ledger. */
const taxRecapRoute = registerApiRoute(`${OPEN_API_PREFIX}/finance/tax-recap`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Tax recap (PPN + withholding) for a period', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    try {
      return c.json(await taxRecap(auth.tenantId, q(c, 'from'), q(c, 'to')));
    } catch (err) {
      return openApiJsonError(c, 400, 'query_failed', err instanceof Error ? err.message : 'Failed.');
    }
  },
});

export const financeReportRoutes = [trialBalanceRoute, ledgerRoute, profitLossRoute, exportRoute, taxRecapRoute];
