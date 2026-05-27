import type { TiktokClient } from './client';
import type { NormalizedOrderDetail, NormalizedOrderItem } from '../shared/orders';
import { redactShopCipher, ttOrderDetailDebug } from './order-detail-debug';
import { normalizedTiktokOrderStatus } from './order-status';

const TIKTOK_ORDERS_GET_PATH = '/order/202309/orders';
/** Some regions reject this POST path (404 / 36009009); order lookup via GET `orders?ids=` is the documented partner pattern. */
const TIKTOK_ORDER_DETAIL_PATH = '/order/202309/orders/detail/query';
const TIKTOK_ORDER_SEARCH_PATH = '/order/202309/orders/search';

interface TiktokOrderItem {
  id?: string | number | bigint;
  sku_id?: string | number | bigint;
  seller_sku?: string;
  product_name?: string;
  product_id?: string | number | bigint;
  /** Present on some order payloads when lines are allocated to a package. */
  package_id?: string | number | bigint;
  quantity?: number;
  sku_image?: string;
  sale_price?: string;
  currency?: string;
}

interface TiktokPackage {
  id?: string | number | bigint;
  package_id?: string | number | bigint;
}

interface TiktokAddress {
  name?: string;
  phone_number?: string;
  detail_address?: string;
  district_info?: {
    city?: string;
    state?: string;
    zipcode?: string;
    country?: string;
  };
}

interface TiktokOrderDetail {
  id?: string | number | bigint;
  order_id?: string | number | bigint;
  /** Open API primary field (string or legacy int). */
  order_status?: string | number;
  /** Some payloads expose duplicate under `status`. */
  status?: string | number;
  /** Legacy string label when `order_status` is numeric. */
  order_status_old?: string;
  create_time?: number;
  update_time?: number;
  buyer_user_id?: string;
  payment?: { total_amount?: string; currency?: string };
  line_items?: TiktokOrderItem[];
  package_list?: TiktokPackage[];
  packages?: TiktokPackage[];
  shipping_provider?: string;
  recipient_address?: TiktokAddress;
}

interface TiktokOrderDetailResponse {
  code?: number;
  message?: string;
  data?: {
    orders?: TiktokOrderDetail[];
  };
}

interface TiktokOrderSearchResponse {
  code?: number;
  message?: string;
  data?: {
    orders?: TiktokOrderDetail[];
  };
}

/** Normalize TikTok snowflake ids (often > 2^53) from JSON numbers or strings. */
export function coerceTiktokId(v: string | number | bigint | null | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function collectPackageIds(row: TiktokOrderDetail): string[] {
  const fromPkgs = [...(row.package_list ?? []), ...(row.packages ?? [])]
    .map((p) => coerceTiktokId(p.package_id) ?? coerceTiktokId(p.id))
    .filter((v): v is string => Boolean(v));
  const fromLines = (row.line_items ?? [])
    .map((i) => coerceTiktokId(i.package_id))
    .filter((v): v is string => Boolean(v));
  return Array.from(new Set([...fromPkgs, ...fromLines]));
}

function mapTiktokItem(item: TiktokOrderItem, currency: string | undefined): NormalizedOrderItem {
  const amount = item.sale_price !== undefined ? Number(item.sale_price) : undefined;
  return {
    id: coerceTiktokId(item.id) ?? coerceTiktokId(item.product_id) ?? coerceTiktokId(item.sku_id),
    sku: item.seller_sku ?? (item.sku_id != null ? String(item.sku_id) : undefined),
    name: item.product_name,
    quantity: item.quantity,
    price: Number.isFinite(amount) ? amount : undefined,
    currency: item.currency ?? currency,
  };
}

function toNormalized(
  client: TiktokClient,
  row: TiktokOrderDetail,
  includeRaw: boolean,
  /** API shop scope for this row (multi-seller: pass `shop_cipher`, not connection `external_shop_id`). */
  shopIdForRow?: string,
): NormalizedOrderDetail | null {
  const orderId = coerceTiktokId(row.order_id) ?? coerceTiktokId(row.id);
  if (!orderId) return null;
  const amountRaw = row.payment?.total_amount;
  const amount = amountRaw !== undefined ? Number(amountRaw) : undefined;
  const address = row.recipient_address;
  const shopId = (shopIdForRow?.trim() || client.shopId) as string;
  return {
    platform: 'tiktok',
    shopId,
    orderId,
    status: normalizedTiktokOrderStatus(row),
    buyerName: row.buyer_user_id,
    totalAmount: Number.isFinite(amount) ? amount : undefined,
    currency: row.payment?.currency,
    createdAt: row.create_time ? new Date(row.create_time * 1000).toISOString() : undefined,
    updatedAt: row.update_time ? new Date(row.update_time * 1000).toISOString() : undefined,
    items: row.line_items?.map((item) => mapTiktokItem(item, row.payment?.currency)),
    orderLineItemIds: row.line_items?.map((i) => coerceTiktokId(i.id)).filter((v): v is string => Boolean(v)),
    packageIds: collectPackageIds(row),
    shippingProvider: row.shipping_provider,
    recipientName: address?.name,
    recipientPhone: address?.phone_number,
    addressLine1: address?.detail_address,
    city: address?.district_info?.city,
    state: address?.district_info?.state,
    postalCode: address?.district_info?.zipcode,
    country: address?.district_info?.country,
    raw: includeRaw ? row : undefined,
  };
}

function rowOrderId(row: TiktokOrderDetail): string | undefined {
  return coerceTiktokId(row.order_id) ?? coerceTiktokId(row.id);
}

/** TikTok search/detail sometimes returns unrelated rows when filters are ignored — never map them to the requested id. */
function filterRowsMatchingOrderIds(rows: TiktokOrderDetail[], requested: Set<string>): TiktokOrderDetail[] {
  return rows.filter((row) => {
    const oid = rowOrderId(row);
    return oid != null && requested.has(oid);
  });
}

async function fetchOrdersByIdsGet(
  client: TiktokClient,
  orderIds: string[],
  shopCipher: string,
): Promise<TiktokOrderDetail[]> {
  const ids = orderIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const requested = new Set(ids);
  const idsParam = ids.join(',');
  ttOrderDetailDebug('orders GET: request', {
    ids,
    pageSize: Math.max(1, Math.min(100, ids.length)),
    shopCipher: redactShopCipher(shopCipher),
  });
  try {
    const res = await client.get<TiktokOrderDetailResponse>(TIKTOK_ORDERS_GET_PATH, {
      query: {
        ids: idsParam,
        page_size: Math.max(1, Math.min(100, ids.length)),
      },
      shopCipher,
    });
    const raw = res.data?.orders ?? [];
    const filtered = filterRowsMatchingOrderIds(raw, requested);
    ttOrderDetailDebug('orders GET: response', {
      rowCountRaw: raw.length,
      rowCountFiltered: filtered.length,
      shopCipher: redactShopCipher(shopCipher),
      sampleOrderIdsRaw: raw
        .slice(0, 5)
        .map((r) => rowOrderId(r))
        .filter(Boolean),
    });
    return filtered;
  } catch (e) {
    ttOrderDetailDebug('orders GET: error', {
      shopCipher: redactShopCipher(shopCipher),
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

async function fetchViaSearch(
  client: TiktokClient,
  ids: string[],
  shopCipher: string,
): Promise<TiktokOrderDetail[]> {
  const requested = new Set(ids.map((x) => x.trim()).filter(Boolean));
  if (requested.size === 0) return [];

  const pageSize = Math.max(1, Math.min(100, requested.size));
  const idList = [...requested];

  const bodies: Record<string, unknown>[] = [{ ids: idList }, { order_id_list: idList }];

  for (const body of bodies) {
    const shape = 'order_id_list' in body ? 'order_id_list' : 'ids';
    ttOrderDetailDebug('search: request', {
      bodyShape: shape,
      ids: idList,
      pageSize,
      shopCipher: redactShopCipher(shopCipher),
    });
    try {
      const res = await client.post<TiktokOrderSearchResponse>(TIKTOK_ORDER_SEARCH_PATH, {
        query: { page_size: pageSize },
        body,
        shopCipher,
      });
      const raw = res.data?.orders ?? [];
      const filtered = filterRowsMatchingOrderIds(raw, requested);
      ttOrderDetailDebug('search: response', {
        bodyShape: shape,
        rowCountRaw: raw.length,
        rowCountFiltered: filtered.length,
        shopCipher: redactShopCipher(shopCipher),
        sampleOrderIdsRaw: raw
          .slice(0, 5)
          .map((r) => rowOrderId(r))
          .filter(Boolean),
      });
      if (filtered.length > 0) return filtered;
    } catch (e) {
      ttOrderDetailDebug('search: error', {
        bodyShape: shape,
        shopCipher: redactShopCipher(shopCipher),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return [];
}

/**
 * Open API 202309 "Get order detail" expects `order_id_list`; some gateways also accept `ids`.
 * Try both so detail is not silently empty.
 */
async function fetchDetailQueryRows(
  client: TiktokClient,
  orderIds: string[],
  shopCipher: string,
): Promise<TiktokOrderDetail[]> {
  const bodies: Record<string, unknown>[] = [{ order_id_list: orderIds }, { ids: orderIds }];
  for (const body of bodies) {
    const bodyLabel = 'order_id_list' in body ? 'order_id_list' : 'ids';
    try {
      const res = await client.post<TiktokOrderDetailResponse>(TIKTOK_ORDER_DETAIL_PATH, {
        body,
        shopCipher,
      });
      const rows = filterRowsMatchingOrderIds(res.data?.orders ?? [], new Set(orderIds));
      ttOrderDetailDebug('detail/query: attempt ok', {
        body: bodyLabel,
        orderIds,
        rowCountRaw: (res.data?.orders ?? []).length,
        rowCountFiltered: rows.length,
        shopCipher: redactShopCipher(shopCipher),
        apiMessage: res.message,
        apiCode: res.code,
      });
      if (rows.length > 0) return rows;
    } catch (e) {
      ttOrderDetailDebug('detail/query: attempt error', {
        body: bodyLabel,
        orderIds,
        shopCipher: redactShopCipher(shopCipher),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  ttOrderDetailDebug('detail/query: exhausted body shapes, zero rows', {
    orderIds,
    shopCipher: redactShopCipher(shopCipher),
  });
  return [];
}

export async function getTiktokOrderDetails(
  client: TiktokClient,
  ids: string[],
  shopCipher: string,
  includeRaw = true,
): Promise<Map<string, NormalizedOrderDetail>> {
  const orderIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  const byId = new Map<string, NormalizedOrderDetail>();
  if (orderIds.length === 0) return byId;

  ttOrderDetailDebug('getTiktokOrderDetails: start', {
    orderIds,
    shopCipher: redactShopCipher(shopCipher),
  });

  let rows = await fetchOrdersByIdsGet(client, orderIds, shopCipher);
  if (rows.length === 0) {
    rows = await fetchDetailQueryRows(client, orderIds, shopCipher);
  }
  if (rows.length === 0) {
    ttOrderDetailDebug('getTiktokOrderDetails: GET+detail empty, trying search', {
      orderIds,
      shopCipher: redactShopCipher(shopCipher),
    });
    try {
      rows = await fetchViaSearch(client, orderIds, shopCipher);
    } catch (e) {
      ttOrderDetailDebug('getTiktokOrderDetails: search after empty detail failed', {
        orderIds,
        shopCipher: redactShopCipher(shopCipher),
        error: e instanceof Error ? e.message : String(e),
      });
      rows = [];
    }
  }

  for (const row of rows) {
    const normalized = toNormalized(client, row, includeRaw, shopCipher);
    if (!normalized) {
      ttOrderDetailDebug('getTiktokOrderDetails: skip row (no order id on payload)', {
        order_id: row.order_id,
        id: row.id,
      });
      continue;
    }
    if (!orderIds.includes(normalized.orderId)) {
      ttOrderDetailDebug('getTiktokOrderDetails: row id not in requested list', {
        requested: orderIds,
        normalizedOrderId: normalized.orderId,
      });
    }
    byId.set(normalized.orderId, normalized);
  }

  /** Detail/query sometimes returns fewer orders than requested; search-by-ids often still resolves them. */
  const missingAfterDetail = orderIds.filter((id) => !byId.has(id));
  if (missingAfterDetail.length > 0) {
    ttOrderDetailDebug('getTiktokOrderDetails: missing after first pass, search again', {
      missing: missingAfterDetail,
      shopCipher: redactShopCipher(shopCipher),
    });
    try {
      let extra = await fetchOrdersByIdsGet(client, missingAfterDetail, shopCipher);
      if (extra.length === 0) {
        extra = await fetchViaSearch(client, missingAfterDetail, shopCipher);
      }
      for (const row of extra) {
        const normalized = toNormalized(client, row, includeRaw, shopCipher);
        if (!normalized) continue;
        if (!byId.has(normalized.orderId)) byId.set(normalized.orderId, normalized);
      }
    } catch (e) {
      ttOrderDetailDebug('getTiktokOrderDetails: supplemental search failed', {
        missing: missingAfterDetail,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const stillMissing = orderIds.filter((id) => !byId.has(id));
  ttOrderDetailDebug('getTiktokOrderDetails: done', {
    shopCipher: redactShopCipher(shopCipher),
    resolvedIds: [...byId.keys()],
    stillMissing,
  });

  return byId;
}

/**
 * Resolve TikTok order details when multiple `shop_cipher` values share one token (`open_id`).
 * Tries each cipher in `shopCiphers` (from DB metadata) until all ids are found or exhausted.
 */
export async function resolveTiktokOrderDetailsByShop(
  client: TiktokClient,
  orderIds: string[],
  includeRaw: boolean,
  opts: { shopCiphers: string[] },
): Promise<Map<string, NormalizedOrderDetail>> {
  const byId = new Map<string, NormalizedOrderDetail>();
  const ids = Array.from(new Set(orderIds.map((x) => x.trim()).filter(Boolean)));
  const pending = new Set(ids);

  ttOrderDetailDebug('resolveTiktokOrderDetailsByShop: start', {
    orderIds: ids,
    cipherFingerprints: opts.shopCiphers.map((x) => redactShopCipher(x)),
  });

  const seenCipher = new Set<string>();
  for (const cipher of opts.shopCiphers) {
    const c = cipher.trim();
    if (!c || seenCipher.has(c)) continue;
    seenCipher.add(c);
    if (pending.size === 0) break;
    const passPending = [...pending];
    try {
      const details = await getTiktokOrderDetails(client, passPending, c, includeRaw);
      let matchedThisPass = 0;
      for (const [id, order] of details) {
        if (pending.has(id)) {
          pending.delete(id);
          matchedThisPass += 1;
          if (!byId.has(id)) byId.set(id, order);
        }
      }
      ttOrderDetailDebug('resolveTiktokOrderDetailsByShop: cipher pass', {
        shopCipher: redactShopCipher(c),
        requested: passPending,
        resolvedThisPass: matchedThisPass,
        stillPending: [...pending],
      });
    } catch (e) {
      ttOrderDetailDebug('resolveTiktokOrderDetailsByShop: cipher pass threw', {
        shopCipher: redactShopCipher(c),
        requested: passPending,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  ttOrderDetailDebug('resolveTiktokOrderDetailsByShop: final', {
    found: [...byId.keys()],
    unresolved: [...pending],
  });

  return byId;
}
