// Agent-callable: record an INTERNAL transaction (a sale, service rendered, or expense the seller tells
// the agent about) into the canonical transaction store. Always available — recording is the always-on
// foundation; the accounting/tax projection is a separate (opt-in) layer. Idempotent only if a referenceId
// is given (most internal entries don't need one).
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { recordTransaction, type LineKind } from '../../integrations/finance/transactions-repo';

const LINE_KINDS = ['product', 'service', 'fee', 'tax', 'shipping', 'discount', 'adjustment'] as const;

const lineSchema = z.object({
  lineKind: z.enum(LINE_KINDS),
  description: z.string().optional(),
  amount: z.number(),
  quantity: z.number().optional(),
  unitPrice: z.number().optional(),
  taxAmount: z.number().optional(),
});

const paramsSchema = z.object({
  type: z.string().min(1), // sale | service | expense | refund | adjustment | …
  description: z.string().optional(),
  currency: z.string().optional(),
  occurredAt: z.string().optional(), // ISO date/time
  counterpartyName: z.string().optional(),
  counterpartyNpwp: z.string().optional(),
  referenceId: z.string().optional(), // optional idempotency key
  lines: z.array(lineSchema).min(1),
});

export const recordTransactionTool = createTool({
  id: 'record-transaction',
  strict: false,
  description:
    'Record an internal financial transaction (a sale, a service you provided, or an expense) into the books. Use when the user reports money in/out that is NOT already synced from a marketplace — e.g. "I sold 3 cakes for 150k cash", "paid 500k for ad design service", "office rent 2,000,000". Provide `type` (sale|service|expense|refund|adjustment), and `lines` each with `lineKind` (product|service|fee|tax|shipping|discount|adjustment), `amount`, and optional quantity/unitPrice/description. Amounts in the tenant currency (default IDR). Does NOT create accounting entries by itself.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [
    {
      input: {
        type: 'sale',
        description: 'Walk-in sale, 3 chocolate cakes',
        lines: [{ lineKind: 'product', description: 'Chocolate cake', quantity: 3, unitPrice: 50000, amount: 150000 }],
      },
    },
    {
      input: {
        type: 'expense',
        description: 'Office rent June',
        counterpartyName: 'Pak Budi',
        lines: [{ lineKind: 'adjustment', description: 'Rent', amount: 2000000 }],
      },
    },
  ],
  outputSchema: z.object({ success: z.boolean(), message: z.string(), transactionId: z.string().optional() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, message: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
    }
    const p = parsed.data;
    try {
      const result = await recordTransaction({
        tenantId,
        source: 'internal',
        type: p.type,
        currency: p.currency,
        occurredAt: p.occurredAt,
        description: p.description ?? null,
        externalId: p.referenceId ?? null,
        counterparty:
          p.counterpartyName || p.counterpartyNpwp
            ? { name: p.counterpartyName ?? null, npwp: p.counterpartyNpwp ?? null }
            : null,
        lines: p.lines.map((l) => ({
          lineKind: l.lineKind as LineKind,
          description: l.description ?? null,
          amount: l.amount,
          quantity: l.quantity ?? null,
          unitPrice: l.unitPrice ?? null,
          taxAmount: l.taxAmount ?? 0,
        })),
      });
      const total = p.lines.reduce((s, l) => s + l.amount, 0);
      return {
        success: true,
        transactionId: result.id,
        message: `Recorded ${p.type} (${p.currency ?? 'IDR'} ${total.toLocaleString('id-ID')})${result.created ? '' : ' — updated existing'}.`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Could not record the transaction.' };
    }
  },
});
