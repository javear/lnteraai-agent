// Human-readable transcription of marketplace webhook events for the Active Agent. Turns raw,
// platform-specific status codes (TikTok `IN_TRANSIT`, Shopee `READY_TO_SHIP`, …) into one consistent,
// unambiguous, plain-language message — no raw codes, no LLM guesswork, no internal ids like shop_id.
import type { Platform } from './types';
import type { EventCategory } from './webhook-event-classifier';

interface StatusInfo {
  emoji: string;
  /** Short human label, e.g. "waiting for courier pickup". */
  label: string;
  /** Plain-language explanation of what it means / what to do. */
  meaning: string;
}

const PLATFORM_NAME: Record<string, string> = { tiktok: 'TikTok Shop', shopee: 'Shopee' };

function platformName(p: Platform | string): string {
  return PLATFORM_NAME[p] ?? String(p);
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toUpperCase();
}

// TikTok Shop order_status enum (API 202309+).
const TIKTOK_STATUS: Record<string, StatusInfo> = {
  UNPAID: { emoji: '💳', label: 'awaiting payment', meaning: "the buyer placed the order but hasn't paid yet" },
  ON_HOLD: { emoji: '⏸️', label: 'on hold', meaning: 'temporarily held by TikTok — no action needed yet' },
  AWAITING_SHIPMENT: { emoji: '📦', label: 'ready to ship', meaning: 'it is paid and needs to be packed and shipped' },
  PARTIALLY_SHIPPING: { emoji: '📦', label: 'partially shipped', meaning: 'some items shipped; the rest still need shipping' },
  AWAITING_COLLECTION: { emoji: '🚚', label: 'waiting for courier pickup', meaning: 'packed and ready; the courier will collect it' },
  IN_TRANSIT: { emoji: '🚚', label: 'shipped and in transit', meaning: 'on its way to the buyer' },
  DELIVERED: { emoji: '✅', label: 'delivered', meaning: 'the buyer has received it' },
  COMPLETED: { emoji: '🎉', label: 'completed', meaning: 'the order is finished' },
  CANCELLED: { emoji: '❌', label: 'cancelled', meaning: 'the order was cancelled' },
};

// Shopee order_status enum.
const SHOPEE_STATUS: Record<string, StatusInfo> = {
  UNPAID: { emoji: '💳', label: 'awaiting payment', meaning: "the buyer hasn't completed payment yet" },
  READY_TO_SHIP: { emoji: '📦', label: 'ready to ship', meaning: 'it is paid and ready for you to arrange shipping' },
  PROCESSED: { emoji: '📦', label: 'processed', meaning: 'shipping has been arranged' },
  RETRY_SHIP: { emoji: '📦', label: 'needs re-shipping', meaning: 'shipping failed and needs to be retried' },
  SHIPPED: { emoji: '🚚', label: 'shipped', meaning: 'handed to the courier and on its way to the buyer' },
  TO_CONFIRM_RECEIVE: { emoji: '🚚', label: 'out for delivery', meaning: 'awaiting the buyer to confirm receipt' },
  IN_CANCEL: { emoji: '⏳', label: 'cancellation requested', meaning: 'a cancellation is being processed' },
  CANCELLED: { emoji: '❌', label: 'cancelled', meaning: 'the order was cancelled' },
  TO_RETURN: { emoji: '↩️', label: 'return requested', meaning: 'the buyer has requested a return or refund' },
  INVOICE_PENDING: { emoji: '🧾', label: 'invoice pending', meaning: 'an invoice is required before shipping' },
  COMPLETED: { emoji: '🎉', label: 'completed', meaning: 'the order is finished' },
};

function lookupStatus(platform: Platform | string, status: string | null): StatusInfo | null {
  const key = norm(status);
  if (!key) return null;
  const table = platform === 'tiktok' ? TIKTOK_STATUS : platform === 'shopee' ? SHOPEE_STATUS : null;
  return table?.[key] ?? null;
}

/** Fallback for an unmapped code: AWAITING_COLLECTION -> "awaiting collection" (never show the raw code). */
function humanizeStatus(status: string): string {
  return norm(status).toLowerCase().replace(/_/g, ' ');
}

const CATEGORY_HEADING: Record<EventCategory, string> = {
  orders: 'Order update',
  fulfillment: 'Shipping update',
  returns: 'Return / cancellation',
  products: 'Product update',
  other: 'Marketplace update',
};

const CATEGORY_EMOJI: Record<EventCategory, string> = {
  orders: '🛒',
  fulfillment: '🚚',
  returns: '↩️',
  products: '🏷️',
  other: '🔔',
};

/** Extract the order id + status from a TikTok/Shopee webhook payload (both nest under `data`). */
export function extractOrderEvent(payload: unknown): { orderId: string | null; status: string | null } {
  if (!payload || typeof payload !== 'object') return { orderId: null, status: null };
  const obj = payload as Record<string, unknown>;
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  };
  const orderId = pick(data.order_id, data.ordersn, data.order_sn, obj.order_id, obj.ordersn);
  const status = pick(data.order_status, data.status, obj.order_status, obj.status);
  return { orderId, status };
}

/**
 * Build a consistent, human-readable notification (heading + body) for a marketplace webhook event.
 * Deterministic — same input always yields the same clear message.
 */
export function buildMarketplaceNotification(input: {
  platform: Platform;
  category: EventCategory;
  code: string;
  payload: unknown;
}): { heading: string; text: string } {
  const name = platformName(input.platform);
  const { orderId, status } = extractOrderEvent(input.payload);
  const info = lookupStatus(input.platform, status);
  const orderRef = orderId ? `order #${orderId}` : 'an order';

  const emoji = info?.emoji ?? CATEGORY_EMOJI[input.category] ?? '🔔';
  const heading = `${emoji} ${CATEGORY_HEADING[input.category] ?? 'Marketplace update'}`;

  let text: string;
  if (info) {
    text = `Your ${name} ${orderRef} is now **${info.label}** — ${info.meaning}.`;
  } else if (status) {
    // Unmapped status — humanize it rather than leak the raw code.
    text = `Your ${name} ${orderRef} status changed to **${humanizeStatus(status)}**.`;
  } else {
    const byCat: Record<EventCategory, string> = {
      orders: `New order activity on your ${name} shop.`,
      fulfillment: `A shipping update came in on your ${name} shop.`,
      returns: `A return or cancellation update came in on your ${name} shop.`,
      products: `A product update came in on your ${name} shop.`,
      other: `New activity on your ${name} shop.`,
    };
    text = orderId ? `Your ${name} ${orderRef} was updated.` : byCat[input.category] ?? byCat.other;
  }
  return { heading, text };
}
