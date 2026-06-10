import type { TiktokClient } from './client';
import {
  type NormalizedProduct,
  type PlatformPageResult,
  type SearchOptions,
  PRODUCT_LIST_DESCRIPTION_MAX,
  truncateProductDescription,
} from '../shared/products';

const TIKTOK_SEARCH_PATH = '/product/202309/products/search';

interface TiktokProductImage { uri?: string; url?: string; urls?: string[] }
interface TiktokProductSku {
  id?: string;
  seller_sku?: string;
  price?: { tax_exclusive_price?: string; sale_price?: string; currency?: string };
  inventory?: Array<{ quantity?: number }>;
  sales_attributes?: Array<{ name?: string; value_name?: string }>;
}
interface TiktokProductSummary {
  id: string;
  title?: string;
  status?: string;
  create_time?: number;
  update_time?: number;
  skus?: TiktokProductSku[];
  main_images?: TiktokProductImage[];
  description?: string;
}

interface TiktokProductsSearchResponse {
  code?: number;
  message?: string;
  data?: {
    next_page_token?: string;
    total_count?: number;
    products?: TiktokProductSummary[];
  };
}

function mapStatus(status: string | undefined): NormalizedProduct['status'] {
  if (!status) return 'unknown';
  const upper = status.toUpperCase();
  if (upper === 'ACTIVATE') return 'active';
  if (
    upper === 'DRAFT'
    || upper === 'PENDING'
    || upper === 'FAILED'
    || upper === 'SELLER_DEACTIVATED'
    || upper === 'PLATFORM_DEACTIVATED'
    || upper === 'FREEZE'
    || upper === 'DELETED'
  ) {
    return 'inactive';
  }
  return 'unknown';
}

function statusFilterToTiktok(status: SearchOptions['status']): string | undefined {
  if (status === 'active') return 'ACTIVATE';
  if (status === 'inactive') return 'SELLER_DEACTIVATED';
  return undefined;
}

function pickTiktokPrice(skus: TiktokProductSku[] | undefined): { price?: number; currency?: string } {
  if (!skus || skus.length === 0) return {};
  for (const sku of skus) {
    const raw = sku.price?.sale_price ?? sku.price?.tax_exclusive_price;
    if (!raw) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) return { price: num, currency: sku.price?.currency };
  }
  return {};
}

function pickTiktokImage(images: TiktokProductImage[] | undefined): string | undefined {
  if (!images) return undefined;
  for (const img of images) {
    if (img.urls && img.urls.length > 0) return img.urls[0];
    if (img.url) return img.url;
    if (img.uri) return img.uri;
  }
  return undefined;
}

function slimTiktokSkus(skus: TiktokProductSku[] | undefined): NormalizedProduct['skus'] {
  if (!skus?.length) return undefined;
  const lines = skus.map((s) => {
    const raw = s.price?.sale_price ?? s.price?.tax_exclusive_price;
    const price =
      raw != null && String(raw).length > 0 && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    let quantity = 0;
    for (const row of s.inventory ?? []) quantity += row.quantity ?? 0;
    const line: NonNullable<NormalizedProduct['skus']>[number] = {
      id: s.id,
      sellerSku: s.seller_sku?.trim() ? s.seller_sku : undefined,
      price,
      currency: s.price?.currency,
    };
    if (quantity > 0) line.quantity = quantity;
    return line;
  });
  return lines.length ? lines : undefined;
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

export interface TiktokSearchInput extends SearchOptions {
  pageToken?: string;
  shopCipher?: string;
}

/**
 * Search a TikTok Shop's products via the authenticated seller search endpoint.
 *
 * Pagination uses `next_page_token` returned by the API. Keyword filtering is
 * applied client-side over the page; this endpoint focuses on status/audit/time
 * filters and does not natively keyword-search titles. Price filter is also
 * applied post-response since the body filter does not accept a price range.
 */
export async function searchTiktokProducts(
  client: TiktokClient,
  opts: TiktokSearchInput,
): Promise<PlatformPageResult> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(opts.pageSize)));
  const status = statusFilterToTiktok(opts.status);

  const query: Record<string, string | number> = { page_size: pageSize };
  if (opts.pageToken) query.page_token = opts.pageToken;

  const body: Record<string, unknown> = {};
  if (status) body.status = status;

  const res = await client.post<TiktokProductsSearchResponse>(TIKTOK_SEARCH_PATH, {
    query,
    body,
    shopCipher: opts.shopCipher,
  });

  const includeRaw = opts.includeRaw === true;

  const rows = (res.data?.products ?? []).map((p) => {
    const { price, currency } = pickTiktokPrice(p.skus);
    const image = pickTiktokImage(p.main_images);
    const fullDesc = p.description?.trim() || undefined;
    const skus = slimTiktokSkus(p.skus);
    const stockSum = skus?.reduce((acc, s) => acc + (s.quantity ?? 0), 0) ?? 0;
    const product: NormalizedProduct = {
      platform: 'tiktok',
      shopId: opts.shopCipher ?? client.shopId,
      productId: p.id,
      title: p.title ?? `TikTok product ${p.id}`,
      description: includeRaw ? fullDesc : truncateProductDescription(fullDesc, PRODUCT_LIST_DESCRIPTION_MAX),
      status: mapStatus(p.status),
      price,
      currency,
      imageUrl: image,
      skus,
      totalAvailableStock: stockSum > 0 ? stockSum : undefined,
      raw: includeRaw ? p : undefined,
    };
    return { product, fullDesc };
  });

  const filtered = rows.filter(
    ({ product, fullDesc }) =>
      matchesKeyword(product.title, fullDesc, opts.keyword ?? '')
      && inPriceRange(product.price, opts.priceMin, opts.priceMax),
  ).map(({ product }) => product);

  const sorted = applySort(filtered, opts.sort);

  const nextPageToken = res.data?.next_page_token && res.data.next_page_token !== '' ? res.data.next_page_token : undefined;

  return {
    products: sorted,
    hasMore: Boolean(nextPageToken),
    nextPageToken,
    total: res.data?.total_count,
  };
}
