// Fetch a tenant's recent orders (+ products, when a subscribed insight needs stock) ONCE per run,
// bounded by page caps so a run can't hammer the marketplaces or trip free-tier limits. Mirrors the
// per-connection iteration in search-orders.ts + product-sync-engine.ts, calling the platform
// integration functions directly (no agent tools / requestContext). Best-effort: per-source errors
// are collected, never thrown — a single bad shop never aborts the run.
import { listConnectionsByTenant } from '../integrations/shared/supabase';
import { buildTiktokSearchSlices } from '../integrations/shared/tiktok-shop-scope';
import { getShopeeClient } from '../integrations/shopee/client';
import { getTiktokClient } from '../integrations/tiktok/client';
import { searchShopeeOrders } from '../integrations/shopee/orders';
import { searchTiktokOrders } from '../integrations/tiktok/orders';
import { searchShopeeProducts } from '../integrations/shopee/products';
import { searchTiktokProducts } from '../integrations/tiktok/products';
import type { NormalizedProduct } from '../integrations/shared/products';
import type { OrderWithItems, PrefetchedData } from './types';

export interface PrefetchOptions {
  now: Date;
  /** Order lookback window in days (≤15 to stay within Shopee's per-call range cap). */
  windowDays?: number;
  needProducts?: boolean;
  needOrderItems?: boolean;
  maxOrderPages?: number;
  maxProductPages?: number;
  pageSize?: number;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function prefetchTenantData(tenantId: string, opts: PrefetchOptions): Promise<PrefetchedData> {
  const pageSize = opts.pageSize ?? 50;
  const maxOrderPages = opts.maxOrderPages ?? 4;
  const maxProductPages = opts.maxProductPages ?? 3;
  const windowDays = Math.min(15, opts.windowDays ?? 14);
  const windowTo = Math.floor(opts.now.getTime() / 1000);
  const windowFrom = windowTo - windowDays * 86400;

  const orders: OrderWithItems[] = [];
  const products: NormalizedProduct[] = [];
  const errors: string[] = [];
  let truncated = false;

  const shopeeConns = await listConnectionsByTenant(tenantId, ['shopee']);
  const tiktokConns = await listConnectionsByTenant(tenantId, ['tiktok']);
  const ttSlices = tiktokConns.length ? buildTiktokSearchSlices(tiktokConns) : [];

  // ---- Orders ----
  for (const conn of shopeeConns) {
    try {
      const client = await getShopeeClient(conn.external_shop_id);
      let cursor: string | undefined;
      for (let page = 0; page < maxOrderPages; page++) {
        const res = await searchShopeeOrders(client, {
          createdFrom: windowFrom,
          createdTo: windowTo,
          enrichWithDetails: Boolean(opts.needOrderItems),
          includeRaw: false,
          pageSize,
          cursor,
        });
        orders.push(...(res.orders as OrderWithItems[]));
        if (!res.hasMore || !res.nextShopeeCursor) break;
        cursor = res.nextShopeeCursor;
        if (page === maxOrderPages - 1) truncated = true;
      }
    } catch (e) {
      errors.push(`shopee orders (${conn.external_shop_id}): ${describe(e)}`);
    }
  }
  for (const slice of ttSlices) {
    try {
      const client = await getTiktokClient(slice.conn.external_shop_id);
      let pageToken: string | undefined;
      for (let page = 0; page < maxOrderPages; page++) {
        const res = await searchTiktokOrders(client, {
          createdFrom: windowFrom,
          createdTo: windowTo,
          enrichWithDetails: Boolean(opts.needOrderItems),
          includeRaw: false,
          pageSize,
          pageToken,
          shopCipher: slice.cipher,
        });
        orders.push(...(res.orders as OrderWithItems[]));
        if (!res.hasMore || !res.nextTiktokPageToken) break;
        pageToken = res.nextTiktokPageToken;
        if (page === maxOrderPages - 1) truncated = true;
      }
    } catch (e) {
      errors.push(`tiktok orders (${slice.cipher}): ${describe(e)}`);
    }
  }

  // ---- Products (only when a subscribed insight needs stock) ----
  if (opts.needProducts) {
    for (const conn of shopeeConns) {
      try {
        const client = await getShopeeClient(conn.external_shop_id);
        let offset = 0;
        for (let page = 0; page < maxProductPages; page++) {
          const res = await searchShopeeProducts(client, { pageSize, offset, status: 'active', includeRaw: false });
          products.push(...res.products);
          if (!res.hasMore || typeof res.nextOffset !== 'number') break;
          offset = res.nextOffset;
          if (page === maxProductPages - 1) truncated = true;
        }
      } catch (e) {
        errors.push(`shopee products (${conn.external_shop_id}): ${describe(e)}`);
      }
    }
    for (const slice of ttSlices) {
      try {
        const client = await getTiktokClient(slice.conn.external_shop_id);
        let pageToken: string | undefined;
        for (let page = 0; page < maxProductPages; page++) {
          const res = await searchTiktokProducts(client, {
            pageSize,
            pageToken,
            shopCipher: slice.cipher,
            status: 'active',
            includeRaw: false,
          });
          products.push(...res.products);
          if (!res.hasMore || !res.nextPageToken) break;
          pageToken = res.nextPageToken;
          if (page === maxProductPages - 1) truncated = true;
        }
      } catch (e) {
        errors.push(`tiktok products (${slice.cipher}): ${describe(e)}`);
      }
    }
  }

  return {
    orders,
    products,
    windowFrom,
    windowTo,
    truncated,
    hasOrderItems: Boolean(opts.needOrderItems),
    hasProducts: Boolean(opts.needProducts),
    errors,
  };
}
