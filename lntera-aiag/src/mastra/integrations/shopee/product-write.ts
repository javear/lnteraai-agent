import { getShopeeClient, type ShopeeClient } from './client';
import { getShopeeConfig } from './config';
import { signShop } from './sign';
import { requireConnection } from '../shared/supabase';
import type {
  NormalizedProductDetail,
  NormalizedProductVariant,
} from '../shared/products';

const BASE_INFO_PATH = '/api/v2/product/get_item_base_info';
const MODEL_LIST_PATH = '/api/v2/product/get_model_list';
const UPDATE_ITEM_PATH = '/api/v2/product/update_item';
const UPDATE_PRICE_PATH = '/api/v2/product/update_price';
const UPDATE_STOCK_PATH = '/api/v2/product/update_stock';
const ADD_ITEM_PATH = '/api/v2/product/add_item';
const ADD_MODEL_PATH = '/api/v2/product/add_model';
const UNLIST_ITEM_PATH = '/api/v2/product/unlist_item';
const DELETE_ITEM_PATH = '/api/v2/product/delete_item';
const IMAGE_UPLOAD_PATH = '/api/v2/media_space/upload_image';

const SHOPEE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

interface ShopeePriceInfo {
  currency?: string;
  current_price?: number;
  original_price?: number;
}

interface ShopeeBaseInfoItem {
  item_id: number;
  item_name?: string;
  description?: string;
  item_status?: string;
  category_id?: number;
  brand?: { brand_id?: number };
  image?: { image_id_list?: string[]; image_url_list?: string[] };
  price_info?: ShopeePriceInfo[];
  has_model?: boolean;
  weight?: number;
  dimension?: { package_length?: number; package_width?: number; package_height?: number };
  stock_info_v2?: { summary_info?: { total_available_stock?: number } };
  attribute_list?: Array<{
    attribute_id?: number;
    original_attribute_name?: string;
    attribute_value_list?: Array<{ value_id?: number; original_value_name?: string }>;
  }>;
  description_info?: {
    extended_description?: { field_list?: Array<{ field_type?: string; text?: string }> };
  };
}

interface ShopeeBaseInfoResponse {
  response?: { item_list?: ShopeeBaseInfoItem[] };
  error?: string;
  message?: string;
}

interface ShopeeModelItem {
  model_id?: number;
  model_sku?: string;
  tier_index?: number[];
  price_info?: ShopeePriceInfo[];
  stock_info_v2?: {
    summary_info?: { total_available_stock?: number; total_reserved_stock?: number };
    seller_stock?: Array<{ stock?: number }>;
  };
  image_info?: { image_url?: string };
}

interface ShopeeTierVariation {
  name?: string;
  option_list?: Array<{ option?: string; image?: { image_url?: string } }>;
}

interface ShopeeModelListResponse {
  response?: {
    model?: ShopeeModelItem[];
    tier_variation?: ShopeeTierVariation[];
  };
}

function shopeeDescription(item: ShopeeBaseInfoItem): string | undefined {
  const parts: string[] = [];
  if (item.description?.trim()) parts.push(item.description.trim());
  const fields = item.description_info?.extended_description?.field_list;
  if (fields) {
    for (const f of fields) {
      if (f.text?.trim()) parts.push(f.text.trim());
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function shopeeStatus(value: string | undefined): NormalizedProductDetail['status'] {
  if (!value) return 'unknown';
  const upper = value.toUpperCase();
  if (upper === 'NORMAL') return 'active';
  if (upper === 'UNLIST' || upper === 'DELETED' || upper === 'BANNED') return 'inactive';
  return 'unknown';
}

function buildVariantLabel(
  modelIndex: number[] | undefined,
  tiers: ShopeeTierVariation[] | undefined,
): { label?: string; attributes?: Array<{ name: string; value: string }> } {
  if (!modelIndex || !tiers || tiers.length === 0) return {};
  const pairs: Array<{ name: string; value: string }> = [];
  modelIndex.forEach((optIdx, tierIdx) => {
    const tier = tiers[tierIdx];
    if (!tier) return;
    const opt = tier.option_list?.[optIdx];
    if (!opt?.option) return;
    pairs.push({ name: tier.name ?? `Tier ${tierIdx + 1}`, value: opt.option });
  });
  if (pairs.length === 0) return {};
  return { label: pairs.map((p) => p.value).join(' / '), attributes: pairs };
}

export interface ShopeeModelUpdate {
  modelId: number;
  /** New price in major currency unit (e.g. IDR rupiah). */
  price?: number;
  /** Absolute stock quantity (Shopee accepts integer). */
  stock?: number;
}

/**
 * Returns the full normalized product including variant SKUs, package weight,
 * dimensions, and image IDs (needed for write operations).
 */
export async function getShopeeProductDetail(
  client: ShopeeClient,
  itemId: string,
): Promise<NormalizedProductDetail | null> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) return null;

  const base = await client.get<ShopeeBaseInfoResponse>(BASE_INFO_PATH, {
    item_id_list: String(numeric),
  });
  const item = base.response?.item_list?.[0];
  if (!item) return null;

  let variants: NormalizedProductVariant[] = [];
  let hasVariants = false;
  if (item.has_model) {
    try {
      const models = await client.get<ShopeeModelListResponse>(MODEL_LIST_PATH, {
        item_id: numeric,
      });
      const tiers = models.response?.tier_variation;
      const rows = models.response?.model ?? [];
      hasVariants = rows.length > 0;
      variants = rows.map((m) => {
        const priceInfo = m.price_info?.[0];
        const stock = m.stock_info_v2?.summary_info?.total_available_stock;
        const { label, attributes } = buildVariantLabel(m.tier_index, tiers);
        const variant: NormalizedProductVariant = {
          skuId: String(m.model_id ?? ''),
          sellerSku: m.model_sku?.trim() || undefined,
          label,
          attributes,
          price: priceInfo?.current_price,
          currency: priceInfo?.currency,
          stock: typeof stock === 'number' ? stock : undefined,
          imageUrl: m.image_info?.image_url || undefined,
        };
        return variant;
      });
    } catch {
      hasVariants = true;
    }
  }

  if (variants.length === 0) {
    const priceInfo = item.price_info?.[0];
    const stock = item.stock_info_v2?.summary_info?.total_available_stock;
    variants = [
      {
        skuId: String(item.item_id),
        price: priceInfo?.current_price,
        currency: priceInfo?.currency,
        stock: typeof stock === 'number' ? stock : undefined,
        imageUrl: item.image?.image_url_list?.[0],
      },
    ];
  }

  const detail: NormalizedProductDetail = {
    platform: 'shopee',
    shopId: client.shopId,
    productId: String(item.item_id),
    title: item.item_name ?? `Shopee item ${item.item_id}`,
    description: shopeeDescription(item),
    status: shopeeStatus(item.item_status),
    platformStatus: item.item_status,
    categoryId: item.category_id != null ? String(item.category_id) : undefined,
    brandId: item.brand?.brand_id != null ? String(item.brand.brand_id) : undefined,
    imageUrls: item.image?.image_url_list?.filter(Boolean),
    weightGrams: typeof item.weight === 'number' ? Math.round(item.weight * 1000) : undefined,
    dimensionsCm:
      item.dimension && (item.dimension.package_length || item.dimension.package_width || item.dimension.package_height)
        ? {
            length: item.dimension.package_length,
            width: item.dimension.package_width,
            height: item.dimension.package_height,
          }
        : undefined,
    attributes: item.attribute_list?.map((a) => ({
      id: a.attribute_id != null ? String(a.attribute_id) : undefined,
      name: a.original_attribute_name,
      values: (a.attribute_value_list ?? []).map((v) => ({
        id: v.value_id != null ? String(v.value_id) : undefined,
        name: v.original_value_name,
      })),
    })),
    variants,
    hasVariants,
    raw: { item, modelList: hasVariants ? true : undefined },
  };
  return detail;
}

/** Patch a Shopee item's top-level attributes (title, description, brand, attributes, image_id_list, etc.). */
export async function updateShopeeItem(
  client: ShopeeClient,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  await client.post(UPDATE_ITEM_PATH, {
    body: { item_id: numeric, ...patch },
  });
}

/**
 * Update Shopee SKU prices. For a non-variant item Shopee accepts a single
 * row with `model_id: 0`; for variant items each `model_id` is required.
 */
export async function updateShopeePrices(
  client: ShopeeClient,
  itemId: string,
  updates: ShopeeModelUpdate[],
): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  const list = updates
    .filter((u) => typeof u.price === 'number')
    .map((u) => ({ model_id: u.modelId, original_price: u.price }));
  if (list.length === 0) return;
  await client.post(UPDATE_PRICE_PATH, {
    body: { item_id: numeric, price_list: list },
  });
}

export async function updateShopeeStock(
  client: ShopeeClient,
  itemId: string,
  updates: ShopeeModelUpdate[],
): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  const list = updates
    .filter((u) => typeof u.stock === 'number')
    .map((u) => ({
      model_id: u.modelId,
      seller_stock: [{ stock: Math.max(0, Math.floor(u.stock as number)) }],
    }));
  if (list.length === 0) return;
  await client.post(UPDATE_STOCK_PATH, {
    body: { item_id: numeric, stock_list: list },
  });
}

export interface ShopeeAddItemBody {
  original_price: number;
  description: string;
  item_name: string;
  weight: number;
  category_id: number;
  image: { image_id_list: string[] };
  logistic_info: Array<{ logistic_id: number; enabled: boolean; shipping_fee?: number }>;
  attribute_list?: Array<{
    attribute_id: number;
    attribute_value_list: Array<{ value_id?: number; original_value_name?: string }>;
  }>;
  brand?: { brand_id: number; original_brand_name?: string };
  dimension?: { package_length: number; package_width: number; package_height: number };
  /** When provided, item is created in UNLIST status. */
  unlisted?: boolean;
  /** Stock for non-variant items. Variant items must call /add_model afterwards. */
  seller_stock?: Array<{ stock: number }>;
}

interface ShopeeAddItemResponse {
  response?: { item_id?: number };
  error?: string;
  message?: string;
}

export async function addShopeeItem(
  client: ShopeeClient,
  body: ShopeeAddItemBody,
): Promise<{ itemId: string }> {
  const res = await client.post<ShopeeAddItemResponse>(ADD_ITEM_PATH, { body });
  const id = res.response?.item_id;
  if (!id) throw new Error('Shopee add_item did not return an item_id');
  return { itemId: String(id) };
}

export interface ShopeeAddModelInput {
  /** Tier index pointing into the item's tier_variation list. */
  tierIndex: number[];
  price: number;
  stock?: number;
  sellerSku?: string;
}

export async function addShopeeModels(
  client: ShopeeClient,
  itemId: string,
  tierVariation: Array<{ name: string; option_list: Array<{ option: string }> }>,
  models: ShopeeAddModelInput[],
): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  await client.post(ADD_MODEL_PATH, {
    body: {
      item_id: numeric,
      tier_variation: tierVariation,
      model: models.map((m) => ({
        tier_index: m.tierIndex,
        normal_stock: typeof m.stock === 'number' ? Math.max(0, Math.floor(m.stock)) : 0,
        original_price: m.price,
        model_sku: m.sellerSku ?? '',
      })),
    },
  });
}

export async function unlistShopeeItem(client: ShopeeClient, itemId: string): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  await client.post(UNLIST_ITEM_PATH, {
    body: { item_list: [{ item_id: numeric, unlist: true }] },
  });
}

export async function listShopeeItem(client: ShopeeClient, itemId: string): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  await client.post(UNLIST_ITEM_PATH, {
    body: { item_list: [{ item_id: numeric, unlist: false }] },
  });
}

export async function deleteShopeeItem(client: ShopeeClient, itemId: string): Promise<void> {
  const numeric = Number(itemId);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Shopee item id: ${itemId}`);
  }
  await client.post(DELETE_ITEM_PATH, { body: { item_id: numeric } });
}

/**
 * Upload an image (bytes from any source) and return the Shopee `image_id`.
 * Shopee's media_space/upload_image is a multipart endpoint, so we build
 * the body manually rather than using the JSON-only client helper.
 */
export async function uploadShopeeImage(
  shopId: string,
  buffer: Buffer | Uint8Array,
  mimeType: string,
  filename = 'upload.jpg',
): Promise<string> {
  if (buffer.byteLength > SHOPEE_IMAGE_MAX_BYTES) {
    throw new Error(
      `Image exceeds Shopee max size (${SHOPEE_IMAGE_MAX_BYTES} bytes): got ${buffer.byteLength}`,
    );
  }
  const cfg = getShopeeConfig();
  // Trigger refresh via the client factory, then read the (now fresh) row to sign.
  await getShopeeClient(shopId);
  const conn = await requireConnection('shopee', shopId);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop({
    partnerId: cfg.partnerId,
    partnerKey: cfg.partnerKey,
    path: IMAGE_UPLOAD_PATH,
    timestamp,
    accessToken: conn.access_token,
    shopId: Number(shopId),
  });

  const url = new URL(cfg.baseUrl + IMAGE_UPLOAD_PATH);
  url.searchParams.set('partner_id', String(cfg.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('access_token', conn.access_token);
  url.searchParams.set('shop_id', shopId);
  url.searchParams.set('sign', sign);

  const boundary = `----shopeeImage${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.from(buffer), tail]);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as unknown as BodyInit,
  });
  const text = await res.text();
  let json: { response?: { image_info?: { image_id?: string } }; error?: string; message?: string };
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Shopee image upload returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(
      `Shopee image upload failed (${res.status}): ${json.error ?? 'unknown'} ${json.message ?? ''}`.trim(),
    );
  }
  const imageId = json.response?.image_info?.image_id;
  if (!imageId) {
    throw new Error('Shopee image upload succeeded but image_id is missing.');
  }
  return imageId;
}
