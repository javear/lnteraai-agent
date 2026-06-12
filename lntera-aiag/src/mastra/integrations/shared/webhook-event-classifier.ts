/**
 * Cross-platform marketplace webhook event classifier.
 *
 * Initial allow-list (per product decision): orders, fulfillment, returns/refunds/cancellation.
 * Anything else is classified as `other` and the webhook handler must reply 200 OK without
 * invoking the agent — this keeps Shopee/TikTok from retrying while we ignore noise.
 */

import type { Platform } from './types';

export type EventCategory = 'orders' | 'fulfillment' | 'returns' | 'products' | 'other';

export interface ClassifiedEvent {
  category: EventCategory;
  /** Original platform code/type kept verbatim for logs + agent prompts. */
  code: string;
}

/**
 * TikTok Shop webhook `type` field (see Partner Center docs).
 * Values map to numeric codes in the payload; we accept both shapes.
 *
 * Allow-list categories:
 * - orders: order status change events
 * - fulfillment: package / shipping document updates
 * - returns: refund / return / cancellation events
 */
const TIKTOK_ORDER_CODES = new Set([
  'ORDER_STATUS_CHANGE',
  'ORDER_STATUS_UPDATE',
]);
const TIKTOK_FULFILLMENT_CODES = new Set([
  'PACKAGE_UPDATE',
  'PACKAGE_STATUS_UPDATE',
  'SHIPPING_DOC_UPDATE',
]);
const TIKTOK_RETURNS_CODES = new Set([
  'RETURN_STATUS_CHANGE',
  'RETURN_STATUS_UPDATE',
  'REFUND_STATUS_UPDATE',
  'CANCELLATION_UPDATE',
  'CANCELLATION_STATUS_UPDATE',
  'REVERSE_ORDER_UPDATE',
]);
const TIKTOK_PRODUCT_CODES = new Set([
  'PRODUCT_STATUS_CHANGE',
  'PRODUCT_INFO_CHANGE',
  'PRODUCT_CREATE',
  'PRODUCT_UPDATE',
]);

/**
 * Numeric TikTok webhook types (some Partner Center apps expose codes only as numbers).
 *  1  Order status update
 *  2  Reverse order status (return / cancellation)
 *  4  Package update
 *  5  Shipping document update (carrier label)
 *  9  Order tax info
 *  12 Cancellation status update
 *
 * Sources differ between Partner Center revisions; allow-list errs toward what we actually
 * want to forward to the agent. Anything not listed below is treated as `other`.
 */
const TIKTOK_TYPE_CODE_TO_CATEGORY: Record<number, EventCategory> = {
  1: 'orders',
  2: 'returns',
  4: 'fulfillment',
  5: 'fulfillment',
  12: 'returns',
};

/**
 * Shopee push partner v2 codes (`code` in the JSON envelope).
 *
 * Allow-list:
 *  3  Order status update
 *  4  Tracking number push
 *  5  Shipping document update
 *  8  Order trackingno_push (regional variant)
 *  10 Return / refund update
 *  11 Order cancellation update
 *  12 Booking status update (treated as fulfillment)
 *
 * Other codes (product, banner, etc.) → `other`.
 */
const SHOPEE_CODE_TO_CATEGORY: Record<number, EventCategory> = {
  3: 'orders',
  4: 'fulfillment',
  5: 'fulfillment',
  8: 'fulfillment',
  10: 'returns',
  11: 'returns',
  12: 'fulfillment',
};

/**
 * Some Shopee revisions surface a string `type` alongside the numeric code; accept both.
 */
const SHOPEE_TYPE_TO_CATEGORY: Record<string, EventCategory> = {
  order_status_update: 'orders',
  order_trackingno_push: 'fulfillment',
  shipping_document_update: 'fulfillment',
  return_status_update: 'returns',
  refund_update: 'returns',
  order_cancel: 'returns',
  item_update: 'products',
  item_add: 'products',
  item_delete: 'products',
  item_status_update: 'products',
  reserved_stock_change: 'products',
  promotion_stock_change: 'products',
};

function classifyTiktok(typeRaw: unknown): ClassifiedEvent {
  if (typeof typeRaw === 'number') {
    const cat = TIKTOK_TYPE_CODE_TO_CATEGORY[typeRaw] ?? 'other';
    return { category: cat, code: `type:${typeRaw}` };
  }
  if (typeof typeRaw === 'string') {
    const upper = typeRaw.trim().toUpperCase();
    if (TIKTOK_ORDER_CODES.has(upper)) return { category: 'orders', code: upper };
    if (TIKTOK_FULFILLMENT_CODES.has(upper)) return { category: 'fulfillment', code: upper };
    if (TIKTOK_RETURNS_CODES.has(upper)) return { category: 'returns', code: upper };
    if (TIKTOK_PRODUCT_CODES.has(upper) || upper.startsWith('PRODUCT')) {
      return { category: 'products', code: upper };
    }
    if (upper.startsWith('CANCELLATION') || upper.startsWith('REFUND') || upper.startsWith('RETURN')) {
      return { category: 'returns', code: upper };
    }
    if (upper.startsWith('PACKAGE') || upper.startsWith('SHIPPING') || upper.startsWith('FULFILLMENT')) {
      return { category: 'fulfillment', code: upper };
    }
    if (upper.startsWith('ORDER')) return { category: 'orders', code: upper };
    return { category: 'other', code: upper };
  }
  return { category: 'other', code: 'unknown' };
}

function classifyShopee(codeRaw: unknown, typeRaw: unknown): ClassifiedEvent {
  if (typeof codeRaw === 'number') {
    const cat = SHOPEE_CODE_TO_CATEGORY[codeRaw];
    if (cat) return { category: cat, code: `code:${codeRaw}` };
  }
  if (typeof typeRaw === 'string') {
    const lower = typeRaw.trim().toLowerCase();
    const cat = SHOPEE_TYPE_TO_CATEGORY[lower];
    if (cat) return { category: cat, code: lower };
    if (lower.startsWith('item')) return { category: 'products', code: lower };
  }
  if (typeof codeRaw === 'number') {
    return { category: 'other', code: `code:${codeRaw}` };
  }
  if (typeof typeRaw === 'string') {
    return { category: 'other', code: typeRaw };
  }
  return { category: 'other', code: 'unknown' };
}

/**
 * Single entry point: given a parsed JSON webhook payload and the platform, return the event
 * category and a stable identifier suitable for logs / agent prompts.
 */
export function classifyWebhookEvent(platform: Platform, payload: unknown): ClassifiedEvent {
  if (!payload || typeof payload !== 'object') {
    return { category: 'other', code: 'invalid_payload' };
  }
  const obj = payload as Record<string, unknown>;

  if (platform === 'tiktok') {
    // TikTok envelopes use `type` (string or number).
    return classifyTiktok(obj.type);
  }
  return classifyShopee(obj.code, obj.type);
}

/**
 * Convenience predicate used by the webhook handlers to short-circuit before tenant resolution.
 * Products are handled by the deterministic ingest path, NOT the LLM agent — so they are excluded
 * here and routed via `isProductEvent` instead.
 */
export function shouldForwardToAgent(event: ClassifiedEvent): boolean {
  return event.category === 'orders' || event.category === 'fulfillment' || event.category === 'returns';
}

/** Product create/update/delete/stock events → the token-free ingest + re-score path. */
export function isProductEvent(event: ClassifiedEvent): boolean {
  return event.category === 'products';
}

/** Whether the handler should do any work at all (forward to agent OR ingest a product). */
export function shouldProcessEvent(event: ClassifiedEvent): boolean {
  return shouldForwardToAgent(event) || isProductEvent(event);
}
