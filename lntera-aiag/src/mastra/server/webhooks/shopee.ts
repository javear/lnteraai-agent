import { registerApiRoute } from '@mastra/core/server';
import { logErrorBrief } from '../../logger/compact-error';
import {
  extractShopeeShopId,
  resolveShopeePushUrl,
  verifyShopeePushSignature,
} from '../../integrations/shopee/webhook';
import { findShopeeConnectionByShopId } from '../../integrations/shared/marketplace-resolve';
import {
  classifyWebhookEvent,
  shouldForwardToAgent,
} from '../../integrations/shared/webhook-event-classifier';
import { notifyTenantOfMarketplaceEvent } from '../../active-mode/notifier';

const WEBHOOK_PATH = '/webhooks/shopee';

export const shopeeWebhookRoute = registerApiRoute(WEBHOOK_PATH, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Shopee Open Platform push webhook',
    tags: ['Webhooks'],
    description:
      'Verifies the Shopee push signature, classifies the event, resolves the tenant from `shop_id`, then asks the general-agent (active mode) to notify Discord. Always returns 200 OK on signature/JSON/classification success so Shopee does not retry on legitimate "ignored" events.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: {
      200: { description: 'Accepted (delivered, ignored, or queued)' },
      400: { description: 'Malformed JSON body' },
      401: { description: 'Missing or invalid signature' },
      503: { description: 'Push partner key not configured' },
    },
  },
  handler: async (c) => {
    const pushPartnerKey = process.env.SHOPEE_PUSH_PARTNER_KEY?.trim();
    if (!pushPartnerKey) {
      logErrorBrief('[webhook] SHOPEE_PUSH_PARTNER_KEY missing — refusing to accept push', 'env_missing');
      return c.json({ ok: false, error: 'shopee_push_not_configured' }, 503);
    }

    const rawBody = await c.req.text();

    const url = resolveShopeePushUrl({
      reqUrl: c.req.url,
      forwardedProto: c.req.header('x-forwarded-proto') ?? null,
      forwardedHost: c.req.header('x-forwarded-host') ?? null,
      host: c.req.header('host') ?? null,
      pathWithQuery: extractPathWithQuery(c.req.url),
      override: process.env.SHOPEE_PUSH_BASE_URL?.trim() ?? null,
    });

    const verification = verifyShopeePushSignature({
      url,
      rawBody,
      authorizationHeader: c.req.header('authorization') ?? null,
      pushPartnerKey,
    });
    if (!verification.ok) {
      logErrorBrief(`[webhook] shopee signature rejected (${verification.reason})`, verification.reason ?? 'unknown');
      return c.text('invalid signature', 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const event = classifyWebhookEvent('shopee', payload);
    if (!shouldForwardToAgent(event)) {
      return c.json({ ok: true, ignored: true, code: event.code });
    }

    const shopId = extractShopeeShopId(payload);
    if (!shopId) {
      console.warn('[webhook] shopee event missing shop_id', { code: event.code });
      return c.json({ ok: true, ignored: true, reason: 'missing_shop_id' });
    }

    const connection = await findShopeeConnectionByShopId(shopId).catch((err) => {
      logErrorBrief('[webhook] shopee tenant resolve failed', err);
      return null;
    });
    if (!connection) {
      console.info(`[webhook] shopee tenant_not_found (shop_id=${shopId})`);
      return c.json({ ok: true, tenant_not_found: true });
    }

    // Fire-and-forget: ack immediately so Shopee does not retry on slow LLM responses.
    void notifyTenantOfMarketplaceEvent({
      tenantId: connection.tenant_id,
      platform: 'shopee',
      category: event.category,
      code: event.code,
      payload,
    })
      .then((result) => {
        if (result.status !== 'delivered') {
          console.warn(
            `[webhook] shopee notify ${result.status} (tenant=${connection.tenant_id}, reason=${result.reason ?? 'n/a'})`,
          );
        }
      })
      .catch((err) => {
        logErrorBrief('[webhook] shopee notify threw', err);
      });

    return c.json({ ok: true, tenant_id: connection.tenant_id, code: event.code });
  },
});

function extractPathWithQuery(fullUrl: string): string {
  try {
    const u = new URL(fullUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    return WEBHOOK_PATH;
  }
}
