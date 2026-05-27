import type { NormalizedOrder } from './orders';

/**
 * TikTok `/order/.../orders/search` only accepts these `order_status` body values (not our normalized pending/processing labels).
 */
const TIKTOK_API_ORDER_STATUSES = new Set([
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'AWAITING_COLLECTION',
  'PARTIALLY_SHIPPING',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
]);

/** Normalized search-orders `status` → TikTok API filters (OR = multiple calls, merged). */
const NORMALIZED_TO_TIKTOK_API: Record<string, string[]> = {
  pending: ['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT'],
  processing: ['PARTIALLY_SHIPPING'],
  processed: ['AWAITING_COLLECTION'],
  shipped: ['IN_TRANSIT'],
  delivered: ['DELIVERED'],
  completed: ['COMPLETED'],
  cancelled: ['CANCELLED'],
};

/**
 * Shopee `get_order_list` only accepts a subset of statuses as filters; some response-only
 * values (e.g. TO_CONFIRM_RECEIVE) reject with error_param when used as `order_status`.
 * @see mapShopeeStatus in shopee/orders for broader response mapping.
 */
const SHOPEE_API_ORDER_STATUSES = new Set([
  'UNPAID',
  'READY_TO_SHIP',
  'PROCESSED',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'INVOICE_PENDING',
]);

const NORMALIZED_TO_SHOPEE_API: Record<string, string[]> = {
  /** get_order_list: only UNPAID is valid here for “not yet shipped / unpaid”; TO_CONFIRM_RECEIVE is not list-filterable. */
  pending: ['UNPAID'],
  processing: ['READY_TO_SHIP'],
  processed: ['PROCESSED'],
  shipped: ['SHIPPED'],
  delivered: ['SHIPPED'],
  completed: ['COMPLETED'],
  /** IN_CANCEL / TO_RETURN are often invalid as list filters; merge still uses multiple calls. */
  cancelled: ['CANCELLED'],
};

/**
 * Resolve `search-orders` status filter to one or more TikTok API `order_status` strings.
 * - Native TikTok enums are passed through (case-normalized).
 * - Normalized tool labels (`pending`, `processing`, `processed`, …) expand to the right API set.
 * - `unknown` / empty → no filter (`undefined`).
 */
export function resolveTiktokSearchOrderStatuses(status?: string): string[] | undefined {
  if (status == null || status.trim() === '') return undefined;
  const t = status.trim();
  const u = t.toUpperCase();
  if (u === 'UNKNOWN') return undefined;
  if (TIKTOK_API_ORDER_STATUSES.has(u)) return [u];
  const mapped = NORMALIZED_TO_TIKTOK_API[t.toLowerCase()];
  if (mapped) return mapped;
  return [u];
}

/** Same for Shopee `order_status` query param. */
export function resolveShopeeSearchOrderStatuses(status?: string): string[] | undefined {
  if (status == null || status.trim() === '') return undefined;
  const t = status.trim();
  const u = t.toUpperCase();
  if (u === 'UNKNOWN') return undefined;
  if (SHOPEE_API_ORDER_STATUSES.has(u)) return [u];
  const mapped = NORMALIZED_TO_SHOPEE_API[t.toLowerCase()];
  if (mapped) return mapped;
  return [u];
}

/** Dedupe by order id, newest `updatedAt` / `createdAt` first, cap at pageSize. */
export function mergeOrderSearchPages(orders: NormalizedOrder[], pageSize: number): NormalizedOrder[] {
  const seen = new Set<string>();
  const out: NormalizedOrder[] = [];
  for (const o of orders) {
    const k = `${o.orderId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  out.sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  return out.slice(0, Math.max(1, Math.min(100, pageSize)));
}
