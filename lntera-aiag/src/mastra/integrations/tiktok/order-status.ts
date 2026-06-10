import type { NormalizedOrderStatus } from '../shared/orders';
import { ttOrderDetailDebug } from './order-detail-debug';

/**
 * TikTok may return legacy integer `order_status` on some payloads; strings are the current Open API form.
 * @see partner docs — filter `order_status` uses the same string enums on responses.
 */
const ORDER_STATUS_NUMERIC: Record<string, string> = {
  '100': 'UNPAID',
  '101': 'UNPAID',
  '105': 'ON_HOLD',
  '111': 'AWAITING_SHIPMENT',
  '112': 'AWAITING_COLLECTION',
  '114': 'PARTIALLY_SHIPPING',
  '121': 'IN_TRANSIT',
  '122': 'DELIVERED',
  '130': 'COMPLETED',
  '140': 'CANCELLED',
};

function coerceTiktokStatusToken(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'bigint') {
    const k = raw.toString();
    return ORDER_STATUS_NUMERIC[k];
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const k = String(Math.trunc(raw));
    return ORDER_STATUS_NUMERIC[k];
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return undefined;
    if (/^\d+$/.test(t) && ORDER_STATUS_NUMERIC[t]) return ORDER_STATUS_NUMERIC[t];
    return t;
  }
  return undefined;
}

/**
 * Map TikTok order status string (after coercion) to normalized listing/detail status.
 */
export function mapTiktokStatusString(token: string | undefined): NormalizedOrderStatus {
  if (!token) return 'unknown';
  const s = token.toUpperCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (s === 'UNPAID' || s === 'ON_HOLD' || s === 'AWAITING_SHIPMENT') return 'pending';
  if (s === 'AWAITING_COLLECTION') return 'processed';
  if (s === 'PARTIALLY_SHIPPING') return 'processing';
  if (s === 'IN_TRANSIT') return 'shipped';
  if (s === 'DELIVERED') return 'delivered';
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
  ttOrderDetailDebug('tiktok order status unmapped token', { token: s });
  return 'unknown';
}

/** Read status from TikTok order/search row (field names vary by endpoint/version). */
export function normalizedTiktokOrderStatus(row: {
  order_status?: unknown;
  status?: unknown;
  order_status_old?: unknown;
  /** Rare camelCase (proxies / generated clients). */
  orderStatus?: unknown;
}): NormalizedOrderStatus {
  const token =
    coerceTiktokStatusToken(row.order_status) ??
    coerceTiktokStatusToken(row.status) ??
    coerceTiktokStatusToken(row.order_status_old) ??
    coerceTiktokStatusToken(row.orderStatus);
  return mapTiktokStatusString(token);
}
