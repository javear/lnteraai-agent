import { shopeeWebhookRoute } from './shopee';
import { tiktokWebhookRoute } from './tiktok';

/** Marketplace inbound webhooks (signature-verified; no JWT). Append new routes here. */
export const webhookRoutes = [shopeeWebhookRoute, tiktokWebhookRoute];
