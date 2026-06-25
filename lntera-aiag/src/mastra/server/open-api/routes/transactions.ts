import { registerApiRoute } from '@mastra/core/server';
import { logErrorBrief } from '../../../logger/compact-error';
import {
  recordTransaction,
  type LineKind,
  type TransactionLineInput,
  type TransactionSource,
} from '../../../integrations/finance/transactions-repo';
import { getSupabase } from '../../../integrations/shared/supabase';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

type Ctx = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const SOURCES: TransactionSource[] = ['marketplace', 'internal', 'manual'];
const LINE_KINDS: LineKind[] = ['product', 'service', 'fee', 'tax', 'shipping', 'discount', 'adjustment'];
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

function parseLines(raw: unknown): { lines: TransactionLineInput[] } | { error: string } {
  if (raw === undefined) return { lines: [] };
  if (!Array.isArray(raw)) return { error: 'lines must be an array.' };
  const lines: TransactionLineInput[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const kind = LINE_KINDS.includes(o.lineKind as LineKind) ? (o.lineKind as LineKind) : null;
    if (!kind) return { error: `Each line needs lineKind one of ${LINE_KINDS.join('|')}.` };
    const amount = numOrUndef(o.amount);
    if (amount === undefined) return { error: 'Each line needs a numeric amount.' };
    lines.push({
      lineKind: kind,
      amount,
      itemRefType: typeof o.itemRefType === 'string' ? o.itemRefType : null,
      itemRefId: typeof o.itemRefId === 'string' ? o.itemRefId : null,
      externalLineId: typeof o.externalLineId === 'string' ? o.externalLineId : null,
      description: typeof o.description === 'string' ? o.description : null,
      quantity: numOrUndef(o.quantity) ?? null,
      unitPrice: numOrUndef(o.unitPrice) ?? null,
      taxAmount: numOrUndef(o.taxAmount) ?? 0,
      metadata: o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, unknown>) : null,
    });
  }
  return { lines };
}

/**
 * POST /svc/v1/transactions — generic idempotent transaction ingest for any external source.
 * Always-on (not gated by the advanced-finance toggle). Provide `externalId` to dedupe re-deliveries.
 */
const ingestRoute = registerApiRoute(`${OPEN_API_PREFIX}/transactions`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Record a transaction (idempotent by externalId)',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: {
      200: { description: 'Recorded (created or idempotently updated)' },
      400: { description: 'Bad request' },
      401: { description: 'Unauthorized' },
    },
  },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!type) return openApiJsonError(c, 400, 'bad_request', 'type is required (e.g. sale, refund, fee, service, expense).');
    const source = SOURCES.includes(body.source as TransactionSource) ? (body.source as TransactionSource) : 'manual';

    const parsed = parseLines(body.lines);
    if ('error' in parsed) return openApiJsonError(c, 400, 'bad_request', parsed.error);

    try {
      const result = await recordTransaction({
        tenantId: auth.tenantId,
        source,
        marketplaceConnectionId: typeof body.marketplaceConnectionId === 'string' ? body.marketplaceConnectionId : null,
        platform: typeof body.platform === 'string' ? body.platform : null,
        externalId: typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim() : null,
        type,
        status: typeof body.status === 'string' ? body.status : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        grossAmount: numOrUndef(body.grossAmount),
        feeAmount: numOrUndef(body.feeAmount),
        taxAmount: numOrUndef(body.taxAmount),
        netAmount: numOrUndef(body.netAmount),
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
        counterparty: body.counterparty && typeof body.counterparty === 'object' ? (body.counterparty as Record<string, unknown>) : null,
        description: typeof body.description === 'string' ? body.description : null,
        rawPayload: body.rawPayload ?? null,
        metadata: body.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : null,
        lines: parsed.lines,
      });
      return c.json({ ok: true, id: result.id, created: result.created });
    } catch (err) {
      logErrorBrief('[transactions] ingest failed', err);
      return openApiJsonError(c, 400, 'record_failed', err instanceof Error ? err.message : 'Could not record the transaction.');
    }
  },
});

/** GET /svc/v1/transactions — recent transactions for the tenant (newest first). */
const listRoute = registerApiRoute(`${OPEN_API_PREFIX}/transactions`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'List recent transactions',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const { data, error } = await getSupabase()
      .from('tenant_transactions')
      .select('id, source, platform, external_id, type, status, currency, gross_amount, fee_amount, tax_amount, net_amount, occurred_at, description, posted')
      .eq('tenant_id', auth.tenantId)
      .order('occurred_at', { ascending: false })
      .limit(100);
    if (error) return openApiJsonError(c, 400, 'query_failed', error.message);
    return c.json({ transactions: data ?? [] });
  },
});

export const transactionRoutes = [ingestRoute, listRoute];
