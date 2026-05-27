import type { ShopeeClient } from './client';
import {
  type NormalizedProduct,
  type PlatformPageResult,
  type SearchOptions,
  PRODUCT_LIST_DESCRIPTION_MAX,
  truncateProductDescription,
} from '../shared/products';

const SHOPEE_LIST_PATH = '/api/v2/product/get_item_list';
const SHOPEE_BASE_INFO_PATH = '/api/v2/product/get_item_base_info';
const BASE_INFO_BATCH = 50;

interface ShopeeItemListResponse {
  response?: {
    item?: Array<{ item_id: number; item_status?: string; update_time?: number }>;
    total_count?: number;
    has_next_page?: boolean;
    next_offset?: number;
  };
}

interface ShopeePriceInfo {
  currency?: string;
  current_price?: number;
  original_price?: number;
  inflated_price_of_current_price?: number;
}

interface ShopeeItemBaseInfo {
  item_id: number;
  item_name?: string;
  description?: string;
  item_status?: string;
  category_id?: number;
  image?: { image_url_list?: string[] };
  price_info?: ShopeePriceInfo[];
  has_model?: boolean;
  rating_star?: number;
  view_count?: number;
  weight?: number;
  stock_info_v2?: {
    summary_info?: { total_available_stock?: number };
  };
  description_info?: {
    extended_description?: {
      field_list?: Array<{ field_type?: string; text?: string }>;
    };
  };
}

interface ShopeeItemBaseInfoResponse {
  response?: { item_list?: ShopeeItemBaseInfo[] };
}

function mapStatus(status: string | undefined): NormalizedProduct['status'] {
  if (!status) return 'unknown';
  const upper = status.toUpperCase();
  if (upper === 'NORMAL') return 'active';
  if (upper === 'UNLIST' || upper === 'DELETED' || upper === 'BANNED') return 'inactive';
  return 'unknown';
}

function statusFilterToShopee(status: SearchOptions['status']): string[] {
  if (status === 'inactive') return ['UNLIST', 'BANNED', 'DELETED'];
  return ['NORMAL'];
}

function pickPrice(item: ShopeeItemBaseInfo): { price?: number; currency?: string } {
  const info = item.price_info?.[0];
  if (!info) return {};
  return { price: info.current_price, currency: info.currency };
}

/** Plain text for keyword search (listing `description` + extended blocks when API returns them). */
function shopeePlainDescription(item: ShopeeItemBaseInfo): string | undefined {
  const parts: string[] = [];
  if (item.description?.trim()) parts.push(item.description.trim());
  const fields = item.description_info?.extended_description?.field_list;
  if (fields) {
    for (const f of fields) {
      if (f.text?.trim()) parts.push(f.text.trim());
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function matchesKeyword(title: string | undefined, description: string | undefined, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  if (title && title.toLowerCase().includes(k)) return true;
  if (description && description.toLowerCase().includes(k)) return true;
  return false;
}

function inPriceRange(price: number | undefined, min?: number, max?: number): boolean {
  if (typeof min === 'number' && (price === undefined || price < min)) return false;
  if (typeof max === 'number' && (price === undefined || price > max)) return false;
  return true;
}

function applySort(products: NormalizedProduct[], sort: SearchOptions['sort']): NormalizedProduct[] {
  if (!sort || sort === 'relevance') return products;
  const copy = [...products];
  switch (sort) {
    case 'price_asc':
      copy.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
      break;
    case 'price_desc':
      copy.sort((a, b) => (b.price ?? Number.NEGATIVE_INFINITY) - (a.price ?? Number.NEGATIVE_INFINITY));
      break;
    case 'sales':
      copy.sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0));
      break;
  }
  return copy;
}

async function fetchBaseInfoBatched(
  client: ShopeeClient,
  itemIds: number[],
): Promise<ShopeeItemBaseInfo[]> {
  const out: ShopeeItemBaseInfo[] = [];
  for (let i = 0; i < itemIds.length; i += BASE_INFO_BATCH) {
    const slice = itemIds.slice(i, i + BASE_INFO_BATCH);
    const res = await client.get<ShopeeItemBaseInfoResponse>(SHOPEE_BASE_INFO_PATH, {
      item_id_list: slice.join(','),
    });
    if (res.response?.item_list) out.push(...res.response.item_list);
  }
  return out;
}

export interface ShopeeSearchInput extends SearchOptions {
  offset?: number;
}

/**
 * Search Shopee shop products via the seller API.
 *
 * Strategy: `get_item_list` returns IDs only, so we follow up with
 * `get_item_base_info` to enrich names/prices/images, then apply
 * keyword and price filters client-side. Sort is applied to the
 * enriched batch (per-page) since Shopee's seller list endpoint does
 * not natively keyword-filter or sort across statuses cleanly.
 */
export async function searchShopeeProducts(
  client: ShopeeClient,
  opts: ShopeeSearchInput,
): Promise<PlatformPageResult> {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const pageSize = Math.max(1, Math.min(100, Math.floor(opts.pageSize)));
  const statuses = statusFilterToShopee(opts.status);

  const aggregated: ShopeeItemBaseInfo[] = [];
  let cursorOffset = offset;
  let hasNext = false;
  let nextOffset: number | undefined;

  for (const itemStatus of statuses) {
    const list = await client.get<ShopeeItemListResponse>(SHOPEE_LIST_PATH, {
      offset: cursorOffset,
      page_size: pageSize,
      item_status: itemStatus,
    });
    const items = list.response?.item ?? [];
    if (items.length === 0) continue;

    const ids = items.map((i) => i.item_id);
    const enriched = await fetchBaseInfoBatched(client, ids);
    aggregated.push(...enriched);

    if (list.response?.has_next_page) {
      hasNext = true;
      nextOffset = list.response.next_offset ?? cursorOffset + items.length;
      break;
    }
  }

  const includeRaw = opts.includeRaw === true;

  const rows = aggregated.map((item) => {
    const { price, currency } = pickPrice(item);
    const image = item.image?.image_url_list?.[0];
    const fullDesc = shopeePlainDescription(item);
    const stock = item.stock_info_v2?.summary_info?.total_available_stock;
    const product: NormalizedProduct = {
      platform: 'shopee',
      shopId: client.shopId,
      productId: String(item.item_id),
      title: item.item_name ?? `Shopee item ${item.item_id}`,
      description: includeRaw ? fullDesc : truncateProductDescription(fullDesc, PRODUCT_LIST_DESCRIPTION_MAX),
      status: mapStatus(item.item_status),
      price,
      currency,
      imageUrl: image,
      rating: typeof item.rating_star === 'number'
        ? { average: item.rating_star, count: 0 }
        : undefined,
      totalAvailableStock: typeof stock === 'number' ? stock : undefined,
      raw: includeRaw ? item : undefined,
    };
    return { product, fullDesc };
  });

  const filtered = rows.filter(
    ({ product, fullDesc }) =>
      matchesKeyword(product.title, fullDesc, opts.keyword ?? '')
      && inPriceRange(product.price, opts.priceMin, opts.priceMax),
  ).map(({ product }) => product);

  const sorted = applySort(filtered, opts.sort);

  return {
    products: sorted,
    hasMore: hasNext,
    nextOffset,
  };
}
