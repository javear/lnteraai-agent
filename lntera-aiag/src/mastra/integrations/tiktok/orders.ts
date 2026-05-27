import type { TiktokClient } from './client';
import type {
  OrderSearchOptions,
  PlatformOrderPageResult,
  NormalizedOrder,
} from '../shared/orders';
import { getTiktokOrderDetails, coerceTiktokId } from './order-detail';
import { normalizedTiktokOrderStatus } from './order-status';
import { mergeOrderSearchPages, resolveTiktokSearchOrderStatuses } from '../shared/order-search-status';

const TIKTOK_ORDER_SEARCH_PATH = '/order/202309/orders/search';

interface TiktokOrderSummary {
  id?: string | number | bigint;
  order_id?: string | number | bigint;
  order_status?: string | number;
  status?: string | number;
  order_status_old?: string;
  create_time?: number;
  update_time?: number;
  buyer_message?: string;
  buyer_user_id?: string;
  payment?: { total_amount?: string; currency?: string };
}

interface TiktokOrderSearchResponse {
  code?: number;
  message?: string;
  data?: {
    next_page_token?: string;
    orders?: TiktokOrderSummary[];
  };
}

export interface TiktokOrderSearchInput extends OrderSearchOptions {
  pageToken?: string;
  shopCipher: string;
}

function rowOrderId(row: TiktokOrderSummary): string | undefined {
  return coerceTiktokId(row.order_id) ?? coerceTiktokId(row.id);
}

function listRowToTiktokOrder(row: TiktokOrderSummary, client: TiktokClient, opts: TiktokOrderSearchInput): NormalizedOrder {
  const orderId = rowOrderId(row) ?? '';
  const amountRaw = row.payment?.total_amount;
  const amount = amountRaw !== undefined ? Number(amountRaw) : undefined;
  return {
    platform: 'tiktok',
    shopId: opts.shopCipher,
    orderId,
    status: normalizedTiktokOrderStatus(row),
    buyerName: row.buyer_user_id ?? row.buyer_message,
    totalAmount: Number.isFinite(amount) ? amount : undefined,
    currency: row.payment?.currency,
    createdAt: row.create_time ? new Date(row.create_time * 1000).toISOString() : undefined,
    updatedAt: row.update_time ? new Date(row.update_time * 1000).toISOString() : undefined,
    raw: opts.includeRaw === true ? row : undefined,
  };
}

async function executeTiktokOrderSearch(
  client: TiktokClient,
  opts: TiktokOrderSearchInput,
  apiOrderStatus: string | undefined,
): Promise<PlatformOrderPageResult> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(opts.pageSize)));

  const query: Record<string, string | number> = {
    page_size: pageSize,
  };
  if (opts.pageToken) query.page_token = opts.pageToken;

  const body: Record<string, unknown> = {};
  if (apiOrderStatus) body.order_status = apiOrderStatus;
  if (typeof opts.createdFrom === 'number') body.create_time_ge = Math.floor(opts.createdFrom);
  if (typeof opts.createdTo === 'number') body.create_time_lt = Math.floor(opts.createdTo);
  if (typeof opts.updatedFrom === 'number') body.update_time_ge = Math.floor(opts.updatedFrom);
  if (typeof opts.updatedTo === 'number') body.update_time_lt = Math.floor(opts.updatedTo);
  if (opts.orderId) body.ids = [opts.orderId];

  const res = await client.post<TiktokOrderSearchResponse>(TIKTOK_ORDER_SEARCH_PATH, {
    query,
    body,
    shopCipher: opts.shopCipher,
  });

  const rows = res.data?.orders ?? [];
  const filtered = opts.orderId ? rows.filter((r) => rowOrderId(r) === opts.orderId) : rows;

  const nextToken =
    res.data?.next_page_token && res.data?.next_page_token !== '' ? res.data.next_page_token : undefined;

  const includeRaw = opts.includeRaw === true;
  const enrich = opts.enrichWithDetails !== false;

  let orders: NormalizedOrder[] = filtered
    .map((row) => {
      if (!rowOrderId(row)) return null;
      return listRowToTiktokOrder(row, client, opts);
    })
    .filter((v): v is NormalizedOrder => v !== null);

  if (enrich && filtered.length > 0) {
    const ids = filtered
      .map((r) => rowOrderId(r))
      .filter((id): id is string => Boolean(id));
    try {
      const detailMap = await getTiktokOrderDetails(client, ids, opts.shopCipher, includeRaw);
      orders = filtered
        .map((row) => {
          const oid = rowOrderId(row);
          if (!oid) return null;
          return detailMap.get(oid) ?? listRowToTiktokOrder(row, client, opts);
        })
        .filter((v): v is NormalizedOrder => v !== null);
    } catch (err) {
      console.warn(
        '[searchTiktokOrders] enrich order detail failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    orders,
    hasMore: Boolean(nextToken),
    nextTiktokPageToken: nextToken,
  };
}

/**
 * Search TikTok orders. `opts.status` may be a TikTok API enum (e.g. AWAITING_SHIPMENT) or a normalized label
 * (`pending`, `processing`, `processed`, …) which is expanded to the correct API filters.
 */
export async function searchTiktokOrders(
  client: TiktokClient,
  opts: TiktokOrderSearchInput,
): Promise<PlatformOrderPageResult> {
  const filters = resolveTiktokSearchOrderStatuses(opts.status);
  if (!filters) {
    return executeTiktokOrderSearch(client, opts, undefined);
  }
  if (filters.length === 1) {
    return executeTiktokOrderSearch(client, opts, filters[0]);
  }
  // OR over several TikTok statuses (e.g. pending → UNPAID + ON_HOLD + AWAITING_SHIPMENT). Cursor not composed across calls.
  const pages = await Promise.all(
    filters.map((st) =>
      executeTiktokOrderSearch(client, { ...opts, pageToken: undefined }, st),
    ),
  );
  const merged = mergeOrderSearchPages(
    pages.flatMap((p) => p.orders),
    opts.pageSize,
  );
  return {
    orders: merged,
    hasMore: false,
    nextTiktokPageToken: undefined,
  };
}
