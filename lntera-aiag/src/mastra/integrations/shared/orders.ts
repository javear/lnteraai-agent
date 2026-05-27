import type { Platform } from './types';

export type OrderPlatform = Extract<Platform, 'shopee' | 'tiktok'>;

export type NormalizedOrderStatus =
  | 'pending'
  | 'processing'
  /** Seller arranged logistics / awaiting handover or pickup (Shopee PROCESSED, TikTok AWAITING_COLLECTION). */
  | 'processed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'completed'
  | 'unknown';

const NORMALIZED_ORDER_STATUS_MEANINGS: Record<NormalizedOrderStatus, string> = {
  pending:
    'Not in active post-payment fulfillment yet: unpaid, on hold, buyer confirmation pending, or paid but seller has not completed steps to hand over to the carrier (varies by platform; e.g. TikTok AWAITING_SHIPMENT).',
  processing:
    'Seller still must act to move the order forward: e.g. Shopee READY_TO_SHIP (arrange shipment/handover), or TikTok PARTIALLY_SHIPPING (only some packages shipped).',
  processed:
    'Shipment/logistics is arranged; waiting on carrier pickup or handover — not the same as in transit (e.g. Shopee PROCESSED, TikTok AWAITING_COLLECTION).',
  shipped: 'Carrier has the package; order is in transit to the buyer.',
  delivered: 'Delivered to the buyer; confirmation or return windows may still apply on the marketplace.',
  completed: 'Marketplace considers the order finished (e.g. receipt confirmed, settled).',
  cancelled: 'Cancelled or in cancel/return states we map here (e.g. Shopee IN_CANCEL / TO_RETURN).',
  unknown:
    'Response status could not be mapped to our normalized set — inspect `raw` or platform docs if needed.',
};

/** Plain-language explanation of `status` for tool / LLM consumers. */
export function normalizedOrderStatusMeaning(status: NormalizedOrderStatus): string {
  return NORMALIZED_ORDER_STATUS_MEANINGS[status];
}

export interface NormalizedOrder {
  platform: OrderPlatform;
  /** Route key for tools / DB: Shopee shop id; TikTok `shop_cipher` for the shop that owns the row when multi-shop. */
  shopId: string;
  orderId: string;
  status: NormalizedOrderStatus;
  /** Set on agent tool responses (`search-orders`, `get-order-details`) alongside `status`. */
  statusMeaning?: string;
  buyerName?: string;
  totalAmount?: number;
  currency?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface NormalizedOrderItem {
  id?: string;
  sku?: string;
  name?: string;
  quantity?: number;
  price?: number;
  currency?: string;
}

export interface NormalizedOrderDetail extends NormalizedOrder {
  packageIds?: string[];
  /** TikTok: `line_items[].id` from order detail (order line item ids for fulfillment APIs). */
  orderLineItemIds?: string[];
  items?: NormalizedOrderItem[];
  shippingProvider?: string;
  recipientName?: string;
  recipientPhone?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface OrderDetailTarget {
  id: string;
  platform: OrderPlatform;
  /**
   * Connected marketplace shop identifier (`marketplace_connections.external_shop_id`).
   * When set, details are fetched only from that shop (efficient, no cross-shop guessing).
   */
  shopId?: string;
}

export interface OrderDetailResult {
  id: string;
  platform: OrderPlatform;
  success: boolean;
  message?: string;
  order?: NormalizedOrderDetail;
  raw?: unknown;
}

export interface OrderDetailSummary {
  total: number;
  success: number;
  failed: number;
}

export function buildOrderDetailSummary(results: OrderDetailResult[]): OrderDetailSummary {
  const success = results.filter((r) => r.success).length;
  return {
    total: results.length,
    success,
    failed: results.length - success,
  };
}

export interface OrderSearchOptions {
  status?: string;
  orderId?: string;
  createdFrom?: number;
  createdTo?: number;
  updatedFrom?: number;
  updatedTo?: number;
  pageSize: number;
  /** Full platform payloads on each row; search-orders defaults this off to save LLM context. */
  includeRaw?: boolean;
  /**
   * When true (search-orders default), list rows are hydrated with batched detail APIs
   * (line items, recipient, packages, etc.) without a separate tool call.
   */
  enrichWithDetails?: boolean;
}

export interface PlatformOrderPageResult {
  orders: NormalizedOrder[];
  hasMore: boolean;
  nextShopeeCursor?: string;
  /** Present when the tenant has multiple Shopee connections (key = external_shop_id). */
  nextShopeeByShop?: Record<string, string>;
  nextTiktokPageToken?: string;
  /** Present when the tenant has multiple TikTok connections (key = external_shop_id). */
  nextTiktokByShop?: Record<string, string>;
}

export interface OrderCursorState {
  /**
   * Shopee pagination. Single-shop tenants typically use `cursor` only.
   * Multi-shop tenants use `byShop` keyed by `external_shop_id` (see marketplace_connections).
   */
  shopee?: {
    cursor?: string;
    byShop?: Record<string, string | undefined>;
  };
  tiktok?: {
    pageToken?: string;
    byShop?: Record<string, string | undefined>;
  };
}

function orderCursorHasContinuation(state: OrderCursorState): boolean {
  const tt = state.tiktok;
  if (tt?.pageToken) return true;
  if (tt?.byShop) {
    for (const v of Object.values(tt.byShop)) {
      if (v) return true;
    }
  }
  const sh = state.shopee;
  if (!sh) return false;
  if (sh.cursor) return true;
  if (sh.byShop) {
    for (const v of Object.values(sh.byShop)) {
      if (v) return true;
    }
  }
  return false;
}

export function encodeOrderCursor(state: OrderCursorState | null): string | null {
  if (!state) return null;
  if (!orderCursorHasContinuation(state)) return null;
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeOrderCursor(cursor: string | undefined | null): OrderCursorState {
  if (!cursor) return {};
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') {
      return parsed as OrderCursorState;
    }
  } catch {
    // ignore malformed cursor and start fresh
  }
  return {};
}
