import { registerApiRoute } from '@mastra/core/server';
import { logErrorBrief } from '../../../logger/compact-error';
import { applyProductSyncAction } from '../../../sync/product-sync-actions';
import { applySyncProposal } from '../../../sync/apply-sync-proposal';
import { resyncMarketplaceProducts } from '../../../sync/product-sync-engine';
import { notifyResyncOutcome } from '../../../sync/product-sync-notifier';
import { setSyncPrefs } from '../../../integrations/shared/sync-prefs';
import type { Platform } from '../../../integrations/shared/types';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

type ActionContext = OpenApiHandlerContext & {
  req: { param: (name: string) => string | undefined };
};

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

/**
 * POST /svc/v1/products/sync-actions/:linkId — apply a token-free decision on a product link.
 * Tenant-scoped (any user of the tenant may act on the shared product mappings). NEVER invokes the
 * agent: it mutates the mapping/catalog directly and returns a confirmation the client shows inline.
 */
const syncActionRoute = registerApiRoute(`${OPEN_API_PREFIX}/products/sync-actions/:linkId`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Apply a product-sync decision (create / map / skip / undo)',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: {
      200: { description: 'Action applied' },
      400: { description: 'Bad request' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden (link belongs to another tenant)' },
      404: { description: 'Link not found' },
    },
  },
  handler: async (c: ActionContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const linkId = c.req.param('linkId');
    if (!linkId) return openApiJsonError(c, 400, 'bad_request', 'A linkId is required.');

    const body = (await c.req.json<{ choice?: string }>().catch(() => ({}))) as { choice?: string };
    const choice = (body.choice ?? '').trim();
    if (!choice) return openApiJsonError(c, 400, 'bad_request', 'A choice is required.');

    const result = await applyProductSyncAction({ tenantId: auth.tenantId, linkId, choice });
    if (result.status === 'not_found') return openApiJsonError(c, 404, 'not_found', result.message);
    if (result.status === 'forbidden') return openApiJsonError(c, 403, 'forbidden', result.message);
    if (result.status === 'invalid') return openApiJsonError(c, 400, 'bad_request', result.message);
    if (!result.ok) return openApiJsonError(c, 422, 'action_failed', result.message);

    return c.json({
      ok: result.ok,
      status: result.status,
      message: result.message,
      mappingStatus: result.mappingStatus,
      prefUpdated: result.prefUpdated,
    });
  },
});

/**
 * POST /svc/v1/products/resync — kick off a background catalog resync. Returns immediately; the
 * engine fans out per product and the outcome (prompts + summary) arrives via the Notifications
 * thread / realtime popup. `mode`: sync_now | sync_auto (also enable auto create+map) | import_all
 * (enable auto-create so pending items get added).
 */
const resyncRoute = registerApiRoute(`${OPEN_API_PREFIX}/products/resync`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Resync marketplace products into the catalog (async)',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Accepted' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: ActionContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const tenantId = auth.tenantId;

    const body = (await c.req
      .json<{ platform?: string; mode?: string; autoFuture?: boolean }>()
      .catch(() => ({}))) as { platform?: string; mode?: string; autoFuture?: boolean };
    const platform: Platform | undefined =
      body.platform === 'shopee' || body.platform === 'tiktok' ? body.platform : undefined;
    const mode = (body.mode ?? '').trim();

    void (async () => {
      try {
        if (mode === 'sync_auto' || body.autoFuture === true) {
          await setSyncPrefs(tenantId, { autoCreateNew: true, autoMapHighConfidence: true });
        } else if (mode === 'import_all') {
          await setSyncPrefs(tenantId, { autoCreateNew: true });
        }
        const summary = await resyncMarketplaceProducts({ tenantId, platform });
        await notifyResyncOutcome(tenantId, summary);
      } catch (err) {
        logErrorBrief(`[products] resync failed tenant=${tenantId}`, err);
      }
    })();

    return c.json({
      ok: true,
      accepted: true,
      message: "Importing your products… you'll be notified as items are found.",
    });
  },
});

/**
 * POST /svc/v1/products/sync-proposals/:proposalId — apply ('apply' / 'apply_always') or 'dismiss' a
 * bidirectional-sync propagation proposal. Apply re-validates against current internal truth before
 * pushing; 'apply_always' flips the tenant to autopilot for that attribute. Never invokes the agent.
 */
const syncProposalRoute = registerApiRoute(`${OPEN_API_PREFIX}/products/sync-proposals/:proposalId`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Apply or dismiss a bidirectional-sync propagation proposal',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: {
      200: { description: 'Applied / dismissed' },
      400: { description: 'Bad request' },
      401: { description: 'Unauthorized' },
      404: { description: 'Proposal not found' },
    },
  },
  handler: async (c: ActionContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const proposalId = c.req.param('proposalId');
    if (!proposalId) return openApiJsonError(c, 400, 'bad_request', 'A proposalId is required.');

    const body = (await c.req.json<{ choice?: string }>().catch(() => ({}))) as { choice?: string };
    const choice = (body.choice ?? '').trim();
    if (!choice) return openApiJsonError(c, 400, 'bad_request', 'A choice is required.');

    const result = await applySyncProposal({ tenantId: auth.tenantId, proposalId, choice });
    if (result.status === 'not_found') return openApiJsonError(c, 404, 'not_found', result.message);
    if (result.status === 'invalid') return openApiJsonError(c, 400, 'bad_request', result.message);
    return c.json({ ok: true, status: result.status, message: result.message, prefUpdated: result.prefUpdated });
  },
});

export const productSyncActionRoutes = [syncActionRoute, resyncRoute, syncProposalRoute];
