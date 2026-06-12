import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { resyncMarketplaceProducts, type ResyncSummary } from '../../sync/product-sync-engine';
import { setSyncPrefs } from '../../integrations/shared/sync-prefs';
// NOTE: product-sync-notifier is imported dynamically inside execute() to avoid a static import
// cycle (general-agent → tools barrel → this tool → notifier → web-delivery → general-agent).

const platformEnum = z.enum(['shopee', 'tiktok']);

const paramsSchema = z
  .object({
    platform: platformEnum,
    maxItems: z.number().int().min(1).max(2000),
    cursor: z.string(),
    /** Also turn on auto-create + auto-map for future products on this tenant. */
    autoFuture: z.boolean(),
  })
  .partial()
  .passthrough();

const inputSchema = z.record(z.string(), z.unknown());

function widen(input: unknown): Record<string, unknown> {
  const base = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  return base;
}

function buildSummaryText(s: ResyncSummary): string {
  if (s.status === 'no_connection') {
    return 'No connected marketplace to sync. Connect Shopee or TikTok Shop first.';
  }
  if (s.status === 'all_synced') {
    return `All ${s.scanned} product${s.scanned === 1 ? '' : 's'} are already synced.`;
  }
  const parts: string[] = [`Scanned ${s.scanned} product${s.scanned === 1 ? '' : 's'}.`];
  if (s.autoCreated) parts.push(`${s.autoCreated} added to your catalog`);
  if (s.autoMapped) parts.push(`${s.autoMapped} auto-linked`);
  if (s.awaitingReview) parts.push(`${s.awaitingReview} awaiting your review`);
  if (s.alreadyMapped) parts.push(`${s.alreadyMapped} already synced`);
  if (s.errors.length) parts.push(`${s.errors.length} error${s.errors.length === 1 ? '' : 's'}`);
  let text = parts.join(' · ');
  if (s.nextCursor) text += ' More remain — run again to continue.';
  return text;
}

export const syncMarketplaceProductsTool = createTool({
  id: 'sync-marketplace-products',
  strict: false,
  description:
    'Import/refresh your marketplace products into your catalog. Detects new vs already-synced and asks you about uncertain matches. Params optional ({} = all connected platforms). autoFuture also keeps future products in sync automatically.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema,
  inputExamples: [{ input: {} }, { input: { platform: 'shopee' } }, { input: { autoFuture: true } }],
  outputSchema: z.object({
    status: z.string(),
    scanned: z.number(),
    autoCreated: z.number(),
    autoMapped: z.number(),
    awaitingReview: z.number(),
    alreadyMapped: z.number(),
    errorCount: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    summaryText: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(widen(input));
    if (!parsed.success) {
      throw new Error(`Invalid sync-marketplace-products input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const args = parsed.data;

    if (args.autoFuture) {
      await setSyncPrefs(tenantId, { autoCreateNew: true, autoMapHighConfidence: true });
    }

    const summary = await resyncMarketplaceProducts({
      tenantId,
      platform: args.platform,
      maxItems: args.maxItems,
      cursor: args.cursor ?? null,
    });

    // Token-free: dispatch the per-product prompts (coalesced into a batch when many).
    // Dynamic import breaks the static dependency cycle through the notifier → web-delivery → agent.
    const { dispatchResyncNotices } = await import('../../sync/product-sync-notifier');
    await dispatchResyncNotices(tenantId, summary);

    return {
      status: summary.status,
      scanned: summary.scanned,
      autoCreated: summary.autoCreated,
      autoMapped: summary.autoMapped,
      awaitingReview: summary.awaitingReview,
      alreadyMapped: summary.alreadyMapped,
      errorCount: summary.errors.length,
      hasMore: Boolean(summary.nextCursor),
      nextCursor: summary.nextCursor,
      summaryText: buildSummaryText(summary),
    };
  },
});
