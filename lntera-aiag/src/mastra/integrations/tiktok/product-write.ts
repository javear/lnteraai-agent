import type { TiktokClient } from './client';
import type {
  NormalizedProductDetail,
  NormalizedProductVariant,
} from '../shared/products';

const TIKTOK_API_VERSION = '202309';
const PRODUCT_DETAIL_PATH = (id: string) => `/product/${TIKTOK_API_VERSION}/products/${id}`;
const PRODUCT_CREATE_PATH = `/product/${TIKTOK_API_VERSION}/products`;
const PRODUCT_SAVE_DRAFT_PATH = `/product/${TIKTOK_API_VERSION}/products/save_draft`;
const PRODUCT_PARTIAL_EDIT_PATH = (id: string) => `/product/${TIKTOK_API_VERSION}/products/${id}/partial_edit`;
const PRODUCT_INVENTORY_PATH = (id: string) => `/product/${TIKTOK_API_VERSION}/products/${id}/inventory/update`;
const PRODUCT_PRICES_PATH = (id: string) => `/product/${TIKTOK_API_VERSION}/products/${id}/prices/update`;
const PRODUCT_ACTIVATE_PATH = `/product/${TIKTOK_API_VERSION}/products/activate`;
const PRODUCT_DEACTIVATE_PATH = `/product/${TIKTOK_API_VERSION}/products/deactivate`;
const PRODUCT_RECOVER_PATH = `/product/${TIKTOK_API_VERSION}/products/recover`;
const PRODUCT_DELETE_PATH = `/product/${TIKTOK_API_VERSION}/products`;
const PRODUCT_SEARCH_PATH = `/product/${TIKTOK_API_VERSION}/products/search`;
const PRODUCT_IMAGE_UPLOAD_PATH = `/product/${TIKTOK_API_VERSION}/images/upload`;

/**
 * TikTok product status enum (from developer docs). We expose the raw value
 * on `platformStatus` for diagnostics; `status` collapses to active|inactive.
 */
export const TIKTOK_STATUS_DRAFT = 'DRAFT';
export const TIKTOK_STATUS_ACTIVATE = 'ACTIVATE';
export const TIKTOK_STATUS_LISTED_UNDER_REVIEW = 'LISTED_UNDER_REVIEW';
export const TIKTOK_STATUS_LISTED_REJECTED = 'LISTED_REJECTED';

interface TiktokDescriptionImage { uri?: string; url?: string; urls?: string[] }
interface TiktokSku {
  id?: string;
  seller_sku?: string;
  price?: { tax_exclusive_price?: string; sale_price?: string; currency?: string };
  inventory?: Array<{ warehouse_id?: string; quantity?: number }>;
  sales_attributes?: Array<{ id?: string; name?: string; value_id?: string; value_name?: string }>;
}
interface TiktokAttribute {
  id?: string;
  name?: string;
  values?: Array<{ id?: string; name?: string }>;
}
interface TiktokProduct {
  id?: string;
  title?: string;
  status?: string;
  description?: string;
  category_chains?: Array<{ id?: string }>;
  brand?: { id?: string };
  main_images?: TiktokDescriptionImage[];
  skus?: TiktokSku[];
  product_attributes?: TiktokAttribute[];
  package_weight?: { value?: string; unit?: string };
  package_dimensions?: { length?: string; width?: string; height?: string; unit?: string };
}

interface TiktokProductDetailResponse {
  code?: number;
  message?: string;
  data?: TiktokProduct;
}

interface TiktokProductMutationResponse {
  code?: number;
  message?: string;
  data?: { product_id?: string; warnings?: unknown };
}

function tiktokStatus(value: string | undefined): NormalizedProductDetail['status'] {
  if (!value) return 'unknown';
  const upper = value.toUpperCase();
  if (upper === TIKTOK_STATUS_ACTIVATE) return 'active';
  if (
    upper === TIKTOK_STATUS_DRAFT
    || upper === TIKTOK_STATUS_LISTED_UNDER_REVIEW
    || upper === TIKTOK_STATUS_LISTED_REJECTED
    || upper === 'SELLER_DEACTIVATED'
    || upper === 'PLATFORM_DEACTIVATED'
    || upper === 'FREEZE'
    || upper === 'DELETED'
    || upper === 'PENDING'
    || upper === 'FAILED'
  ) {
    return 'inactive';
  }
  return 'unknown';
}

function pickImageUrls(images: TiktokDescriptionImage[] | undefined): { urls: string[]; uris: string[] } {
  if (!images) return { urls: [], uris: [] };
  const urls: string[] = [];
  const uris: string[] = [];
  for (const img of images) {
    if (img.uri) uris.push(img.uri);
    if (img.urls?.length) urls.push(...img.urls);
    else if (img.url) urls.push(img.url);
  }
  return { urls, uris };
}

function pickVariantImage(sku: TiktokSku): { url?: string; uri?: string } {
  void sku;
  return {};
}

function buildVariantLabel(
  attrs: TiktokSku['sales_attributes'],
): { label?: string; attributes?: Array<{ name: string; value: string }> } {
  if (!attrs || attrs.length === 0) return {};
  const pairs = attrs
    .map((a) => ({ name: a.name?.trim() ?? '', value: a.value_name?.trim() ?? '' }))
    .filter((p) => p.name && p.value);
  if (pairs.length === 0) return {};
  return { label: pairs.map((p) => p.value).join(' / '), attributes: pairs };
}

function variantFromSku(sku: TiktokSku, fallbackImageUrl?: string): NormalizedProductVariant {
  const priceRaw = sku.price?.sale_price ?? sku.price?.tax_exclusive_price;
  const price = priceRaw != null && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : undefined;
  let stock = 0;
  const inventoryByWarehouse: Array<{ warehouseId?: string; quantity: number }> = [];
  for (const inv of sku.inventory ?? []) {
    const qty = inv.quantity ?? 0;
    stock += qty;
    inventoryByWarehouse.push({ warehouseId: inv.warehouse_id?.trim() || undefined, quantity: qty });
  }
  const { label, attributes } = buildVariantLabel(sku.sales_attributes);
  const img = pickVariantImage(sku);
  return {
    skuId: sku.id ?? '',
    sellerSku: sku.seller_sku?.trim() || undefined,
    label,
    attributes,
    price,
    currency: sku.price?.currency,
    stock: stock > 0 ? stock : 0,
    inventoryByWarehouse: inventoryByWarehouse.length > 0 ? inventoryByWarehouse : undefined,
    imageUrl: img.url ?? fallbackImageUrl,
    imageUri: img.uri,
    tiktokPriceFields: sku.price
      ? {
          salePrice: sku.price.sale_price?.trim() || undefined,
          taxExclusivePrice: sku.price.tax_exclusive_price?.trim() || undefined,
        }
      : undefined,
  };
}

function parseGrams(weight?: { value?: string; unit?: string }): number | undefined {
  if (!weight?.value) return undefined;
  const num = Number(weight.value);
  if (!Number.isFinite(num)) return undefined;
  const unit = (weight.unit ?? 'GRAM').toUpperCase();
  if (unit === 'GRAM' || unit === 'G') return Math.round(num);
  if (unit === 'KILOGRAM' || unit === 'KG') return Math.round(num * 1000);
  if (unit === 'POUND' || unit === 'LB') return Math.round(num * 453.592);
  if (unit === 'OUNCE' || unit === 'OZ') return Math.round(num * 28.3495);
  return Math.round(num);
}

function parseCm(value?: string, unit?: string): number | undefined {
  if (value == null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const u = (unit ?? 'CENTIMETER').toUpperCase();
  if (u === 'CENTIMETER' || u === 'CM') return num;
  if (u === 'INCH' || u === 'IN') return num * 2.54;
  if (u === 'MILLIMETER' || u === 'MM') return num / 10;
  return num;
}

export async function getTiktokProductDetail(
  client: TiktokClient,
  productId: string,
  shopCipher: string,
): Promise<NormalizedProductDetail | null> {
  const res = await client.get<TiktokProductDetailResponse>(PRODUCT_DETAIL_PATH(productId), {
    shopCipher,
  });
  const p = res.data;
  if (!p?.id) return null;

  const images = pickImageUrls(p.main_images);
  const fallbackUrl = images.urls[0];
  const variants = (p.skus ?? []).map((s) => variantFromSku(s, fallbackUrl));
  const dim = p.package_dimensions;
  const dimensionsCm = dim
    ? {
        length: parseCm(dim.length, dim.unit),
        width: parseCm(dim.width, dim.unit),
        height: parseCm(dim.height, dim.unit),
      }
    : undefined;

  return {
    platform: 'tiktok',
    shopId: shopCipher,
    productId: p.id,
    title: p.title ?? `TikTok product ${p.id}`,
    description: p.description,
    status: tiktokStatus(p.status),
    platformStatus: p.status,
    categoryId: p.category_chains?.[p.category_chains.length - 1]?.id,
    brandId: p.brand?.id,
    imageUrls: images.urls,
    imageUris: images.uris,
    weightGrams: parseGrams(p.package_weight),
    dimensionsCm,
    attributes: p.product_attributes?.map((a) => ({
      id: a.id,
      name: a.name,
      values: (a.values ?? []).map((v) => ({ id: v.id, name: v.name })),
    })),
    variants,
    hasVariants: variants.length > 1 || variants.some((v) => v.attributes && v.attributes.length > 0),
    raw: p,
  };
}

/**
 * Save (create or update) a draft. TikTok accepts partial fields here, so this
 * is the entry point we use when the agent first starts a draft.
 *
 * When `product_id` is omitted a new draft is created; when provided, the
 * existing draft is updated. The 202309 endpoint actually accepts the same
 * `body` shape as create, returning the (possibly new) `product_id`.
 */
export async function saveTiktokDraft(
  client: TiktokClient,
  body: Record<string, unknown>,
  shopCipher: string,
): Promise<{ productId: string }> {
  const res = await client.post<TiktokProductMutationResponse>(PRODUCT_SAVE_DRAFT_PATH, {
    body,
    shopCipher,
  });
  const id = res.data?.product_id;
  if (!id) throw new Error('TikTok save_draft did not return a product_id');
  return { productId: id };
}

/** Partial edit any existing product (works for drafts and listed items). */
export async function partialEditTiktokProduct(
  client: TiktokClient,
  productId: string,
  body: Record<string, unknown>,
  shopCipher: string,
): Promise<void> {
  await client.post(PRODUCT_PARTIAL_EDIT_PATH(productId), { body, shopCipher });
}

/** Full edit (PUT) an existing product — used when publishing a complete draft. */
export async function editTiktokProduct(
  client: TiktokClient,
  productId: string,
  body: Record<string, unknown>,
  shopCipher: string,
): Promise<void> {
  await client.put(PRODUCT_DETAIL_PATH(productId), { body, shopCipher });
}

/** Create a brand new product directly (skipping the draft step). */
export async function createTiktokProduct(
  client: TiktokClient,
  body: Record<string, unknown>,
  shopCipher: string,
): Promise<{ productId: string }> {
  const res = await client.post<TiktokProductMutationResponse>(PRODUCT_CREATE_PATH, {
    body,
    shopCipher,
  });
  const id = res.data?.product_id;
  if (!id) throw new Error('TikTok create product did not return a product_id');
  return { productId: id };
}

/** Currencies TikTok treats as zero-decimal (no fractional units in API strings). */
const TIKTOK_ZERO_DECIMAL_CURRENCIES = new Set([
  'IDR',
  'VND',
  'JPY',
  'KRW',
  'CLP',
  'PYG',
  'UGX',
  'RWF',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
  'KMF',
  'DJF',
  'GNF',
]);

/**
 * Format a numeric price for TikTok Shop write APIs. IDR/VND/JPY etc. must be
 * whole-number strings; USD-style markets allow up to 2 decimal places.
 */
export function formatTiktokApiPrice(amount: number, currency?: string | null): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid TikTok price amount: ${amount}`);
  }
  const code = currency?.trim().toUpperCase() || null;
  if (code && TIKTOK_ZERO_DECIMAL_CURRENCIES.has(code)) {
    return String(Math.round(amount));
  }
  if (!code && Math.abs(amount - Math.round(amount)) < 1e-9) {
    return String(Math.round(amount));
  }
  const rounded = Math.round(amount * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return String(Math.round(rounded));
  }
  return rounded.toFixed(2);
}

interface TiktokPriceFields {
  sale_price?: string;
  tax_exclusive_price?: string;
  currency?: string;
}

/** Price object for TikTok draft/create SKU payloads (includes required `currency`). */
export function buildTiktokSkuPriceForApi(amount: number, currency: string): Record<string, string> {
  const code = currency.trim();
  const formatted = formatTiktokApiPrice(amount, code);
  return {
    currency: code,
    sale_price: formatted,
    tax_exclusive_price: formatted,
  };
}

function buildTiktokPriceUpdatePayload(
  amount: number,
  currency: string,
  existing?: TiktokPriceFields | null,
): Record<string, string> {
  const formatted = formatTiktokApiPrice(amount, currency);
  const payload: Record<string, string> = { currency: currency.trim() };
  const hadSale = Boolean(existing?.sale_price?.trim());
  const hadTaxEx = Boolean(existing?.tax_exclusive_price?.trim());

  if (hadTaxEx && !hadSale) {
    payload.tax_exclusive_price = formatted;
  } else if (hadSale && !hadTaxEx) {
    payload.sale_price = formatted;
  } else {
    payload.sale_price = formatted;
    payload.tax_exclusive_price = formatted;
  }
  return payload;
}

export interface TiktokSkuPriceUpdate {
  skuId: string;
  price: number;
  currency: string;
  /** Raw price object from product detail — preserves sale vs tax-exclusive field usage. */
  existingPrice?: TiktokPriceFields | null;
}

function isTiktokDedicatedPriceUpdateRejected(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bcode=12052092\b/.test(msg) || /product price is invalid/i.test(msg);
}

function buildTiktokPriceUpdateSkusBody(updates: TiktokSkuPriceUpdate[]): Record<string, unknown> {
  return {
    skus: updates.map((u) => {
      if (!u.currency?.trim()) {
        throw new Error('TikTok price update requires SKU currency from the existing product.');
      }
      return {
        id: u.skuId,
        price: buildTiktokPriceUpdatePayload(u.price, u.currency, u.existingPrice),
      };
    }),
  };
}

export async function updateTiktokPrices(
  client: TiktokClient,
  productId: string,
  updates: TiktokSkuPriceUpdate[],
  shopCipher: string,
): Promise<void> {
  if (updates.length === 0) return;
  const body = buildTiktokPriceUpdateSkusBody(updates);
  try {
    await client.post(PRODUCT_PRICES_PATH(productId), { body, shopCipher });
  } catch (e) {
    // Sandbox / some listings reject dedicated prices/update (12052092) but accept partial_edit.
    if (!isTiktokDedicatedPriceUpdateRejected(e)) throw e;
    await partialEditTiktokProduct(client, productId, body, shopCipher);
  }
}

export interface TiktokSkuInventoryUpdate {
  skuId: string;
  quantity: number;
  warehouseId?: string;
}

export async function updateTiktokInventory(
  client: TiktokClient,
  productId: string,
  updates: TiktokSkuInventoryUpdate[],
  shopCipher: string,
): Promise<void> {
  if (updates.length === 0) return;
  await client.post(PRODUCT_INVENTORY_PATH(productId), {
    body: {
      skus: updates.map((u) => ({
        id: u.skuId,
        inventory: [
          {
            quantity: Math.max(0, Math.floor(u.quantity)),
            ...(u.warehouseId ? { warehouse_id: u.warehouseId } : {}),
          },
        ],
      })),
    },
    shopCipher,
  });
}

export async function activateTiktokProducts(
  client: TiktokClient,
  productIds: string[],
  shopCipher: string,
): Promise<void> {
  if (productIds.length === 0) return;
  await client.post(PRODUCT_ACTIVATE_PATH, { body: { product_ids: productIds }, shopCipher });
}

export async function deactivateTiktokProducts(
  client: TiktokClient,
  productIds: string[],
  shopCipher: string,
): Promise<void> {
  if (productIds.length === 0) return;
  await client.post(PRODUCT_DEACTIVATE_PATH, { body: { product_ids: productIds }, shopCipher });
}

export async function recoverTiktokProducts(
  client: TiktokClient,
  productIds: string[],
  shopCipher: string,
): Promise<void> {
  if (productIds.length === 0) return;
  await client.post(PRODUCT_RECOVER_PATH, { body: { product_ids: productIds }, shopCipher });
}

export async function deleteTiktokProducts(
  client: TiktokClient,
  productIds: string[],
  shopCipher: string,
): Promise<void> {
  if (productIds.length === 0) return;
  await client.delete(PRODUCT_DELETE_PATH, { body: { product_ids: productIds }, shopCipher });
}

interface TiktokListDraftsResponse {
  code?: number;
  message?: string;
  data?: {
    next_page_token?: string;
    total_count?: number;
    products?: Array<{ id?: string; title?: string; status?: string; update_time?: number }>;
  };
}

/**
 * List TikTok drafts via the products search endpoint with status filter.
 * Returns lightweight rows so the agent can show a picker before fetching
 * full details.
 */
export async function listTiktokDraftProducts(
  client: TiktokClient,
  shopCipher: string,
  pageSize = 50,
): Promise<Array<{ productId: string; title: string; updatedAt?: Date }>> {
  const res = await client.post<TiktokListDraftsResponse>(PRODUCT_SEARCH_PATH, {
    query: { page_size: pageSize },
    body: { status: TIKTOK_STATUS_DRAFT },
    shopCipher,
  });
  return (res.data?.products ?? []).map((p) => ({
    productId: p.id ?? '',
    title: p.title ?? '',
    updatedAt: typeof p.update_time === 'number' ? new Date(p.update_time * 1000) : undefined,
  })).filter((r) => r.productId);
}

interface TiktokImageUploadResponse {
  code?: number;
  message?: string;
  data?: { uri?: string; url?: string };
}

const TIKTOK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload an image buffer and receive a TikTok image URI usable in product
 * `main_images[].uri` and `description.images[].uri` fields.
 */
export async function uploadTiktokImage(
  client: TiktokClient,
  buffer: Buffer | Uint8Array,
  mimeType: string,
  filename = 'upload.jpg',
): Promise<{ uri: string; url?: string }> {
  if (buffer.byteLength > TIKTOK_IMAGE_MAX_BYTES) {
    throw new Error(
      `Image exceeds TikTok max size (${TIKTOK_IMAGE_MAX_BYTES} bytes): got ${buffer.byteLength}`,
    );
  }
  const boundary = `----tiktokImage${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="data"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.from(buffer), tail]);

  const res = await client.postMultipart<TiktokImageUploadResponse>(PRODUCT_IMAGE_UPLOAD_PATH, {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
    /** Query param (not form field) — required so `uri` is valid for `main_images`. */
    query: { use_case: 'MAIN_IMAGE' },
  });
  const uri = res.data?.uri;
  if (!uri) throw new Error('TikTok image upload succeeded but uri is missing.');
  return { uri, url: res.data?.url };
}
