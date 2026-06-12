import type { Platform } from './types';

export type ProductStatus = 'active' | 'inactive' | 'unknown';

/**
 * Detailed, cross-platform product view returned by `getProductDetails`.
 * Each marketplace driver maps its raw schema into this shape so the agent
 * does not have to know platform-specific field names.
 */
export interface NormalizedProductVariant {
  /** Platform sku id (`model_id` for Shopee, `sku.id` for TikTok). */
  skuId: string;
  /** Seller-defined SKU (optional). */
  sellerSku?: string;
  /** Variant label (joined sales attributes, e.g. "Red / L"). */
  label?: string;
  /** Per-variant attribute pairs (e.g. `[{ name: "Color", value: "Red" }]`). */
  attributes?: Array<{ name: string; value: string }>;
  price?: number;
  currency?: string;
  stock?: number;
  /** Per-warehouse inventory (TikTok `sku.inventory[]`); when absent, `stock` is the summary total
   *  and maps to a single synthetic default warehouse. */
  inventoryByWarehouse?: Array<{ warehouseId?: string; quantity: number }>;
  imageUrl?: string;
  /** TikTok-specific image URI (when the SKU has its own image). */
  imageUri?: string;
  /** Raw TikTok price strings from the platform (for price update write-back). */
  tiktokPriceFields?: { salePrice?: string; taxExclusivePrice?: string };
}

export interface NormalizedProductDetail {
  platform: Platform;
  shopId: string;
  productId: string;
  title: string;
  description?: string;
  status: ProductStatus;
  /** Raw platform status string for diagnostics (`NORMAL`, `DRAFT`, etc.). */
  platformStatus?: string;
  /** Numeric category id from the platform (TikTok uses strings; we coerce). */
  categoryId?: string;
  /** Brand id when known (TikTok). */
  brandId?: string;
  /** Main product images (URLs). For TikTok we also expose `imageUris` because
   *  most write APIs identify images by `uri`, not URL. */
  imageUrls?: string[];
  imageUris?: string[];
  /** Attributes / customizations beyond the standard fields. */
  attributes?: Array<{
    id?: string;
    name?: string;
    values: Array<{ id?: string; name?: string; value?: string }>;
  }>;
  /** Package weight in grams (best effort across platforms). */
  weightGrams?: number;
  /** Package dimensions in cm. */
  dimensionsCm?: { length?: number; width?: number; height?: number };
  variants: NormalizedProductVariant[];
  /** Has at least one variant beyond the default single SKU. */
  hasVariants: boolean;
  raw?: unknown;
}

/** Compact SKU lines for product lists (avoids heavy platform `raw`). */
export interface NormalizedProductSkuLine {
  id?: string;
  sellerSku?: string;
  price?: number;
  currency?: string;
  /** Sum of inventory quantities when rows exist */
  quantity?: number;
}

export interface NormalizedProduct {
  platform: Platform;
  shopId: string;
  productId: string;
  title: string;
  description?: string;
  status: ProductStatus;
  price?: number;
  currency?: string;
  imageUrl?: string;
  url?: string;
  rating?: { average: number; count: number };
  soldCount?: number;
  totalAvailableStock?: number;
  skus?: NormalizedProductSkuLine[];
  raw?: unknown;
}

export type SortOrder = 'relevance' | 'sales' | 'price_asc' | 'price_desc';

export interface SearchOptions {
  keyword?: string;
  status?: 'active' | 'inactive';
  priceMin?: number;
  priceMax?: number;
  sort?: SortOrder;
  pageSize: number;
  /**
   * When false (search-products default), omit `raw` and shorten `description`
   * so list payloads stay small for LLM context.
   */
  includeRaw?: boolean;
}

export interface PlatformPageResult {
  products: NormalizedProduct[];
  hasMore: boolean;
  nextOffset?: number;
  /** Multi-Shopee: next offset per external_shop_id */
  nextShopeeByShop?: Record<string, number>;
  nextPageToken?: string;
  /** Multi-TikTok: next page token per external_shop_id */
  nextTiktokByShop?: Record<string, string>;
  total?: number;
}

export interface CursorState {
  shopee?: {
    /** Single-shop (legacy) */
    offset?: number;
    /** Multi-shop: next offset per external_shop_id */
    byShop?: Record<string, number>;
  };
  tiktok?: {
    pageToken?: string;
    byShop?: Record<string, string | undefined>;
  };
}

function productCursorHasContinuation(state: CursorState): boolean {
  const tt = state.tiktok;
  if (tt?.pageToken) return true;
  if (tt?.byShop) {
    for (const v of Object.values(tt.byShop)) {
      if (v) return true;
    }
  }
  const sh = state.shopee;
  if (typeof sh?.offset === 'number') return true;
  if (sh?.byShop) {
    for (const v of Object.values(sh.byShop)) {
      if (typeof v === 'number') return true;
    }
  }
  return false;
}

export function encodeCursor(state: CursorState | null): string | null {
  if (!state) return null;
  if (!productCursorHasContinuation(state)) return null;
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): CursorState {
  if (!cursor) return {};
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') {
      return parsed as CursorState;
    }
  } catch {
    // ignore malformed cursor and start fresh
  }
  return {};
}

export function clampPageSize(value: number | undefined, fallback = 20, max = 100): number {
  const n = Number.isFinite(value) ? Number(value) : fallback;
  if (n < 1) return 1;
  if (n > max) return max;
  return Math.floor(n);
}

export function splitPageSize(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0))
    .map((n) => Math.max(1, n));
}

/** Max description length in product lists when `includeRaw` is false */
export const PRODUCT_LIST_DESCRIPTION_MAX = 480;

export function truncateProductDescription(
  value: string | undefined,
  maxLen: number,
): string | undefined {
  if (value == null || value === '') return undefined;
  const t = value.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}
