import { registerApiRoute } from '@mastra/core/server';
import { logErrorBrief } from '../../logger/compact-error';
import {
  extractTiktokShopIdentity,
  verifyTiktokWebhookSignature,
} from '../../integrations/tiktok/webhook';
import { getTiktokConfig } from '../../integrations/tiktok/config';
import { findTiktokConnectionByShopId } from '../../integrations/shared/marketplace-resolve';
import {
  classifyWebhookEvent,
  isProductEvent,
  shouldProcessEvent,
} from '../../integrations/shared/webhook-event-classifier';
import { notifyTenantOfMarketplaceEvent } from '../../active-mode/notifier';
import { ingestMarketplaceProductEvent } from '../../sync/ingest-product-event';

const WEBHOOK_PATH = '/webhooks/tiktok';

export const tiktokWebhookRoute = registerApiRoute(WEBHOOK_PATH, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'TikTok Shop Partner Center event webhook',
    tags: ['Webhooks'],
    description:
      'Verifies the X-TTS-Signature, classifies the event, resolves the tenant from the shop id / cipher, then asks the general-agent (active mode) to notify Discord. Always returns 200 OK on signature/JSON/classification success so TikTok does not retry on legitimate "ignored" events.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: {
      200: { description: 'Accepted (delivered, ignored, or queued)' },
      400: { description: 'Malformed JSON body' },
      401: { description: 'Missing or invalid signature' },
      503: { description: 'TikTok app secret not configured' },
    },
  },
  handler: async (c) => {
    let appSecret: string;
    try {
      appSecret = getTiktokConfig().appSecret;
    } catch (err) {
      logErrorBrief('[webhook] TikTok app secret not configured', err);
      return c.json({ ok: false, error: 'tiktok_not_configured' }, 503);
    }

    const rawBody = await c.req.text();

    const signatureHeader =
      c.req.header('x-tts-signature') ??
      c.req.header('X-TTS-Signature') ??
      c.req.header('tts-signature') ??
      null;

    const verification = verifyTiktokWebhookSignature({
      rawBody,
      signatureHeader,
      appSecret,
    });
    if (!verification.ok) {
      logErrorBrief(`[webhook] tiktok signature rejected (${verification.reason})`, verification.reason ?? 'unknown');
      return c.text('invalid signature', 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const event = classifyWebhookEvent('tiktok', payload);
    if (!shouldProcessEvent(event)) {
      return c.json({ ok: true, ignored: true, code: event.code });
    }

    const identity = extractTiktokShopIdentity(payload);
    if (!identity.shopId && !identity.shopCipher) {
      console.warn('[webhook] tiktok event missing shop_id / shop_cipher', { code: event.code });
      return c.json({ ok: true, ignored: true, reason: 'missing_shop_identity' });
    }

    const connection = await findTiktokConnectionByShopId({
      shopId: identity.shopId,
      shopCipher: identity.shopCipher,
    }).catch((err) => {
      logErrorBrief('[webhook] tiktok tenant resolve failed', err);
      return null;
    });
    if (!connection) {
      console.info(
        `[webhook] tiktok tenant_not_found (shop_id=${identity.shopId ?? '-'}, cipher=${identity.shopCipher ? 'set' : '-'})`,
      );
      return c.json({ ok: true, tenant_not_found: true });
    }

    // Product events → deterministic ingest + re-score path (no LLM). Fire-and-forget, ack now.
    if (isProductEvent(event)) {
      void ingestMarketplaceProductEvent({
        tenantId: connection.tenant_id,
        connection,
        platform: 'tiktok',
        code: event.code,
        payload,
      }).catch((err) => logErrorBrief('[webhook] tiktok product ingest threw', err));
      return c.json({ ok: true, tenant_id: connection.tenant_id, code: event.code, product: true });
    }

    // Fire-and-forget: TikTok retries on non-2xx; the agent + Discord write can take seconds.
    void notifyTenantOfMarketplaceEvent({
      tenantId: connection.tenant_id,
      platform: 'tiktok',
      category: event.category,
      code: event.code,
      payload,
    })
      .then((result) => {
        if (result.status !== 'delivered') {
          console.warn(
            `[webhook] tiktok notify ${result.status} (tenant=${connection.tenant_id}, reason=${result.reason ?? 'n/a'})`,
          );
        }
      })
      .catch((err) => {
        logErrorBrief('[webhook] tiktok notify threw', err);
      });

    return c.json({ ok: true, tenant_id: connection.tenant_id, code: event.code });
  },
});
