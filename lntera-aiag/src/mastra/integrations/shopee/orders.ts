import type { ShopeeClient } from './client';
import type {
  OrderSearchOptions,
  PlatformOrderPageResult,
  NormalizedOrderStatus,
  NormalizedOrderDetail,
  NormalizedOrderItem,
  NormalizedOrder,
} from '../shared/orders';
import { mergeOrderSearchPages, resolveShopeeSearchOrderStatuses } from '../shared/order-search-status';

const SHOPEE_ORDER_LIST_PATH = '/api/v2/order/get_order_list';
const SHOPEE_ORDER_DETAIL_PATH = '/api/v2/order/get_order_detail';
const MAX_RANGE_SECONDS = 15 * 24 * 60 * 60;
const SHOPEE_DETAIL_FIELDS = [
  'item_list',
  'package_list',
  'recipient_address',
  'shipping_carrier',
  'payment_method',
  'total_amount',
  'currency',
];

interface ShopeeOrderListEntry {
  order_sn: string;
  order_status?: string;
  create_time?: number;
  update_time?: number;
  total_amount?: number;
  currency?: string;
  buyer_user_name?: string;
}

interface ShopeeOrderListResponse {
  response?: {
    more?: boolean;
    next_cursor?: string;
    order_list?: ShopeeOrderListEntry[];
  };
}

interface ShopeeAddress {
  name?: string;
  phone?: string;
  full_address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
}

interface ShopeeOrderItem {
  item_id?: number;
  model_id?: number;
  item_name?: string;
  model_sku?: string;
  model_quantity_purchased?: number;
  model_discounted_price?: number;
  model_original_price?: number;
}

interface ShopeePackage {
  package_number?: string;
}

interface ShopeeOrderDetailEntry extends ShopeeOrderListEntry {
  recipient_address?: ShopeeAddress;
  item_list?: ShopeeOrderItem[];
  package_list?: ShopeePackage[];
  shipping_carrier?: string;
}

interface ShopeeOrderDetailResponse {
  response?: {
    order_list?: ShopeeOrderDetailEntry[];
  };
}

function mapShopeeStatus(status: string | undefined): NormalizedOrderStatus {
  const s = (status ?? '').toUpperCase();
  if (s === 'UNPAID' || s === 'TO_CONFIRM_RECEIVE') return 'pending';
  if (s === 'READY_TO_SHIP') return 'processing';
  if (s === 'PROCESSED') return 'processed';
  if (s === 'SHIPPED') return 'shipped';
  if (s === 'TO_RETURN' || s === 'IN_CANCEL') return 'cancelled';
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CANCELLED') return 'cancelled';
  return 'unknown';
}

function clampEpoch(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeShopeeRange(
  fromInput: number | undefined,
  toInput: number | undefined,
): { timeFrom: number; timeTo: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  let timeTo = clampEpoch(toInput, nowSec);
  let timeFrom = clampEpoch(fromInput, timeTo - MAX_RANGE_SECONDS);

  // Shopee requires start < end.
  if (timeFrom >= timeTo) {
    timeFrom = Math.max(0, timeTo - 1);
  }

  // Shopee requires diff <= 15 days.
  if (timeTo - timeFrom > MAX_RANGE_SECONDS) {
    timeFrom = Math.max(0, timeTo - MAX_RANGE_SECONDS);
  }

  return { timeFrom, timeTo };
}

export interface ShopeeOrderSearchInput extends OrderSearchOptions {
  cursor?: string;
}

const SHOPEE_ORDER_DETAIL_BATCH = 50;

async function getShopeeOrderDetailsBatched(
  client: ShopeeClient,
  ids: string[],
  includeRaw: boolean,
): Promise<Map<string, NormalizedOrderDetail>> {
  const merged = new Map<string, NormalizedOrderDetail>();
  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  for (let i = 0; i < unique.length; i += SHOPEE_ORDER_DETAIL_BATCH) {
    const chunk = unique.slice(i, i + SHOPEE_ORDER_DETAIL_BATCH);
    try {
      const part = await getShopeeOrderDetails(client, chunk, includeRaw);
      for (const [k, v] of part.entries()) merged.set(k, v);
    } catch (err) {
      console.warn(
        `[searchShopeeOrders] enrich get_order_detail batch failed (${chunk.length} orders):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return merged;
}

function listRowToShopeeOrder(row: ShopeeOrderListEntry, client: ShopeeClient, opts: ShopeeOrderSearchInput): NormalizedOrder {
  return {
    platform: 'shopee',
    shopId: client.shopId,
    orderId: row.order_sn,
    status: mapShopeeStatus(row.order_status),
    buyerName: row.buyer_user_name,
    totalAmount: row.total_amount,
    currency: row.currency,
    createdAt: row.create_time ? new Date(row.create_time * 1000).toISOString() : undefined,
    updatedAt: row.update_time ? new Date(row.update_time * 1000).toISOString() : undefined,
    raw: opts.includeRaw === true ? row : undefined,
  };
}

async function executeShopeeOrderSearch(
  client: ShopeeClient,
  opts: ShopeeOrderSearchInput,
  apiOrderStatus: string | undefined,
): Promise<PlatformOrderPageResult> {
  const { timeFrom, timeTo } = normalizeShopeeRange(
    opts.createdFrom ?? opts.updatedFrom,
    opts.createdTo ?? opts.updatedTo,
  );
  const timeRangeField = opts.updatedFrom || opts.updatedTo ? 'update_time' : 'create_time';
  const pageSize = Math.max(1, Math.min(100, Math.floor(opts.pageSize)));

  const query: Record<string, string | number | boolean | undefined> = {
    time_range_field: timeRangeField,
    time_from: timeFrom,
    time_to: timeTo,
    page_size: pageSize,
    cursor: opts.cursor,
  };
  if (apiOrderStatus) query.order_status = apiOrderStatus;
  if (opts.orderId) {
    query.order_sn = opts.orderId;
  }

  const res = await client.get<ShopeeOrderListResponse>(SHOPEE_ORDER_LIST_PATH, query);
  const rows = res.response?.order_list ?? [];

  const filtered = opts.orderId ? rows.filter((r) => r.order_sn === opts.orderId) : rows;

  const includeRaw = opts.includeRaw === true;
  const enrich = opts.enrichWithDetails !== false;

  let orders: NormalizedOrder[] = filtered.map((row) => listRowToShopeeOrder(row, client, opts));

  if (enrich && filtered.length > 0) {
    const detailMap = await getShopeeOrderDetailsBatched(
      client,
      filtered.map((r) => r.order_sn),
      includeRaw,
    );
    orders = filtered.map((row) => detailMap.get(row.order_sn) ?? listRowToShopeeOrder(row, client, opts));
  }

  return {
    orders,
    hasMore: Boolean(res.response?.more),
    nextShopeeCursor: res.response?.next_cursor,
  };
}

/**
 * Shopee order list wrapper.
 * Uses create/update time range plus cursor pagination.
 * `opts.status` may be a Shopee API order_status or a normalized label (`pending`, `processing`, `processed`, …).
 */
export async function searchShopeeOrders(
  client: ShopeeClient,
  opts: ShopeeOrderSearchInput,
): Promise<PlatformOrderPageResult> {
  const filters = resolveShopeeSearchOrderStatuses(opts.status);
  if (!filters) {
    return executeShopeeOrderSearch(client, opts, undefined);
  }
  if (filters.length === 1) {
    return executeShopeeOrderSearch(client, opts, filters[0]);
  }
  const pages = await Promise.all(
    filters.map((st) =>
      executeShopeeOrderSearch(client, { ...opts, cursor: undefined }, st),
    ),
  );
  const merged = mergeOrderSearchPages(pages.flatMap((p) => p.orders), opts.pageSize);
  return {
    orders: merged,
    hasMore: false,
    nextShopeeCursor: undefined,
  };
}

function mapShopeeItem(row: ShopeeOrderItem, currency: string | undefined): NormalizedOrderItem {
  return {
    id: row.item_id ? String(row.item_id) : row.model_id ? String(row.model_id) : undefined,
    sku: row.model_sku,
    name: row.item_name,
    quantity: row.model_quantity_purchased,
    price: row.model_discounted_price ?? row.model_original_price,
    currency,
  };
}

function toShopeeOrderDetail(client: ShopeeClient, row: ShopeeOrderDetailEntry, includeRaw: boolean): NormalizedOrderDetail {
  const currency = row.currency;
  const address = row.recipient_address;
  return {
    platform: 'shopee',
    shopId: client.shopId,
    orderId: row.order_sn,
    status: mapShopeeStatus(row.order_status),
    buyerName: row.buyer_user_name,
    totalAmount: row.total_amount,
    currency,
    createdAt: row.create_time ? new Date(row.create_time * 1000).toISOString() : undefined,
    updatedAt: row.update_time ? new Date(row.update_time * 1000).toISOString() : undefined,
    packageIds: row.package_list?.map((p) => p.package_number).filter((v): v is string => Boolean(v)),
    items: row.item_list?.map((item) => mapShopeeItem(item, currency)),
    shippingProvider: row.shipping_carrier,
    recipientName: address?.name,
    recipientPhone: address?.phone,
    addressLine1: address?.full_address,
    city: address?.city,
    state: address?.state,
    postalCode: address?.zipcode,
    country: address?.country,
    raw: includeRaw ? row : undefined,
  };
}

export async function getShopeeOrderDetails(
  client: ShopeeClient,
  ids: string[],
  includeRaw = true,
): Promise<Map<string, NormalizedOrderDetail>> {
  const orderSnList = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  const byId = new Map<string, NormalizedOrderDetail>();
  if (orderSnList.length === 0) return byId;

  const res = await client.get<ShopeeOrderDetailResponse>(SHOPEE_ORDER_DETAIL_PATH, {
    order_sn_list: orderSnList.join(','),
    response_optional_fields: SHOPEE_DETAIL_FIELDS.join(','),
  });

  for (const row of res.response?.order_list ?? []) {
    if (!row.order_sn) continue;
    byId.set(row.order_sn, toShopeeOrderDetail(client, row, includeRaw));
  }

  return byId;
}
