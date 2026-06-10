import { z } from 'zod';
import { listConnectionsByTenant } from './supabase';
import {
  insertShopeeDraft,
  getShopeeDraftById,
  patchShopeeDraftData,
  markShopeeDraftDiscarded,
  listShopeeDrafts,
  type ShopeeDraftRow,
} from './shopee-drafts';
import { resolveImageUrlsForProductTool } from './discord-attachment-urls';
import { uploadProductImageFromUrl } from './product-images';
import {
  findTiktokConnectionForToolShopId,
  resolveTiktokShopCurrency,
  tiktokCipherPriorityList,
} from './marketplace-auth';
import { getTiktokClient } from '../tiktok/client';
import {
  buildTiktokSkuPriceForApi,
  getTiktokProductDetail,
  listTiktokDraftProducts,
  partialEditTiktokProduct,
  saveTiktokDraft,
  TIKTOK_STATUS_DRAFT,
} from '../tiktok/product-write';
import type { Platform, Uuid } from './types';

/**
 * Cross-platform product draft schema. Each platform may require a subset
 * of these (see `evaluateDraftReadiness`). Optional everywhere because the
 * agent fills the draft incrementally.
 */
const draftVariantSchema = z
  .object({
    sellerSku: z.string().optional(),
    attributes: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    /** Index into the parent `variantTiers` matrix (Shopee only). */
    tierIndex: z.array(z.number().int().min(0)).optional(),
    price: z.number().nonnegative().optional(),
    stock: z.number().int().nonnegative().optional(),
    imageUrl: z.string().url().optional(),
  })
  .passthrough();

const draftImageSchema = z.object({
  /** Source URL (Discord attachment etc.). */
  sourceUrl: z.string().url(),
  /** Filled after eager upload. */
  shopeeImageId: z.string().optional(),
  tiktokUri: z.string().optional(),
  tiktokUrl: z.string().optional(),
});

export const productDraftInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    categoryId: z.string().optional(),
    brandId: z.string().optional(),
    weightGrams: z.number().int().positive().optional(),
    dimensionsCm: z
      .object({
        length: z.number().positive().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      })
      .optional(),
    /** Images can be passed as a URL list; upload happens eagerly when set. */
    imageUrls: z.array(z.string().url()).optional(),
    /** Already-uploaded images (the agent rarely sets this directly). */
    images: z.array(draftImageSchema).optional(),
    /** Shopee tier variation matrix (e.g. `[{ name: "Color", option_list: [{ option: "Red" }] }]`). */
    variantTiers: z
      .array(
        z.object({
          name: z.string(),
          option_list: z.array(z.object({ option: z.string() })),
        }),
      )
      .optional(),
    /** Single SKU price for non-variant draft. */
    price: z.number().nonnegative().optional(),
    /** Single SKU stock for non-variant draft. */
    stock: z.number().int().nonnegative().optional(),
    /** Variant SKUs (when the product has variants). */
    variants: z.array(draftVariantSchema).optional(),
    /** Shopee-only logistics ids. */
    shopeeLogistics: z
      .array(
        z.object({
          logistic_id: z.number().int().positive(),
          enabled: z.boolean(),
          shipping_fee: z.number().nonnegative().optional(),
        }),
      )
      .optional(),
    /** Attribute list (platform-specific structure). */
    attributes: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          values: z
            .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
            .optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type ProductDraftInput = z.infer<typeof productDraftInputSchema>;

export interface ProductDraftRecord {
  draftId: string;
  platform: Platform;
  tenantId: Uuid;
  shopId: string;
  shopCipher?: string;
  status: 'open' | 'published' | 'discarded';
  data: ProductDraftInput;
  publishedItemId?: string;
  updatedAt: string;
  /** Whether the draft also exists natively on the platform (TikTok only). */
  nativeDraft: boolean;
}

export interface DraftReadiness {
  ready: boolean;
  missing: string[];
}

/** Platform-namespaced draft id. `tt-...` lives on TikTok, `sp-...` lives in Supabase. */
export function parseDraftId(draftId: string): { platform: Platform; rawId: string } {
  const trimmed = draftId.trim();
  if (trimmed.startsWith('tt-')) return { platform: 'tiktok', rawId: trimmed.slice(3) };
  if (trimmed.startsWith('sp-')) return { platform: 'shopee', rawId: trimmed.slice(3) };
  throw new Error(
    `Invalid draft_id "${draftId}". Expected "tt-<tiktok_product_id>" or "sp-<uuid>".`,
  );
}

export function buildShopeeDraftId(uuid: string): string {
  return `sp-${uuid}`;
}
export function buildTiktokDraftId(productId: string): string {
  return `tt-${productId}`;
}

interface ResolveTiktokShopArgs {
  tenantId: Uuid;
  shopId: string;
}

interface ResolvedTiktokShop {
  externalShopId: string;
  shopCipher: string;
}

async function resolveTiktokShop(args: ResolveTiktokShopArgs): Promise<ResolvedTiktokShop> {
  const conns = await listConnectionsByTenant(args.tenantId, ['tiktok']);
  if (conns.length === 0) throw new Error('No TikTok connection found for tenant.');
  const conn = findTiktokConnectionForToolShopId(conns, args.shopId);
  if (!conn) {
    throw new Error(`No TikTok connection for shop "${args.shopId}" on this tenant.`);
  }
  const ciphers = tiktokCipherPriorityList(conn, args.shopId);
  if (ciphers.length === 0) {
    throw new Error(
      'TikTok connection is missing shop_cipher. Reconnect with authorized-shops scope.',
    );
  }
  return { externalShopId: conn.external_shop_id, shopCipher: ciphers[0] };
}

async function resolveShopeeConnectionIdAndShop(
  tenantId: Uuid,
  shopId: string,
): Promise<{ marketplaceConnectionId: string; externalShopId: string }> {
  const conns = await listConnectionsByTenant(tenantId, ['shopee']);
  if (conns.length === 0) throw new Error('No Shopee connection found for tenant.');
  const conn = conns.find((c) => c.external_shop_id === shopId);
  if (!conn) {
    throw new Error(`No Shopee connection for shop "${shopId}" on this tenant.`);
  }
  return { marketplaceConnectionId: conn.id, externalShopId: conn.external_shop_id };
}

/**
 * Eagerly upload any new image URLs in `data.imageUrls` so the draft holds
 * platform identifiers rather than expiring Discord URLs. Mutates a copy of
 * `data` and returns the new payload.
 */
import type { ToolContextLike } from './discord-attachment-urls';

async function eagerUploadImages(
  data: ProductDraftInput,
  platform: Platform,
  shopId: string,
  shopCipher?: string,
  toolContext?: ToolContextLike,
): Promise<ProductDraftInput> {
  const urls = resolveImageUrlsForProductTool(data.imageUrls, toolContext);
  if (urls.length === 0) return data;
  const existingImages = data.images ?? [];
  const uploaded = await Promise.all(
    urls.map(async (url) => {
      const existing = existingImages.find((img) => img.sourceUrl === url);
      if (
        existing
        && ((platform === 'shopee' && existing.shopeeImageId)
          || (platform === 'tiktok' && existing.tiktokUri))
      ) {
        return existing;
      }
      const res = await uploadProductImageFromUrl({ platform, shopId, url, shopCipher });
      return {
        sourceUrl: url,
        shopeeImageId: res.imageId,
        tiktokUri: res.uri,
        tiktokUrl: res.url,
      };
    }),
  );
  const next: ProductDraftInput = { ...data };
  next.images = uploaded;
  // Strip the URL list so we never re-upload on subsequent updates.
  next.imageUrls = undefined;
  return next;
}

/**
 * Build the body posted to TikTok `save_draft` / `partial_edit`. We only send
 * fields that the agent has set so partial drafts are accepted.
 */
function tiktokDraftSkuPrice(
  amount: number,
  currency: string | null | undefined,
): Record<string, string> | undefined {
  if (!currency?.trim()) return undefined;
  return buildTiktokSkuPriceForApi(amount, currency);
}

function buildTiktokDraftBody(
  data: ProductDraftInput,
  shopCurrency?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (data.title) body.title = data.title;
  if (data.description) body.description = data.description;
  if (data.categoryId) body.category_id = data.categoryId;
  if (data.brandId) body.brand_id = data.brandId;

  const imageUris = (data.images ?? []).map((i) => i.tiktokUri).filter(Boolean) as string[];
  if (imageUris.length > 0) {
    body.main_images = imageUris.map((uri) => ({ uri }));
  }

  if (typeof data.weightGrams === 'number') {
    body.package_weight = { value: String(data.weightGrams), unit: 'GRAM' };
  }
  if (data.dimensionsCm) {
    const d = data.dimensionsCm;
    if (d.length || d.width || d.height) {
      body.package_dimensions = {
        length: d.length != null ? String(d.length) : '0',
        width: d.width != null ? String(d.width) : '0',
        height: d.height != null ? String(d.height) : '0',
        unit: 'CENTIMETER',
      };
    }
  }

  const variants = data.variants && data.variants.length > 0 ? data.variants : null;
  if (variants) {
    body.skus = variants.map((v) => ({
      ...(v.sellerSku ? { seller_sku: v.sellerSku } : {}),
      ...(v.attributes && v.attributes.length > 0
        ? { sales_attributes: v.attributes.map((a) => ({ name: a.name, value_name: a.value })) }
        : {}),
      ...(typeof v.price === 'number'
        ? { price: tiktokDraftSkuPrice(v.price, shopCurrency) }
        : {}),
      ...(typeof v.stock === 'number' ? { inventory: [{ quantity: v.stock }] } : {}),
    }));
  } else if (typeof data.price === 'number' || typeof data.stock === 'number') {
    body.skus = [
      {
        ...(typeof data.price === 'number'
          ? { price: tiktokDraftSkuPrice(data.price, shopCurrency) }
          : {}),
        ...(typeof data.stock === 'number' ? { inventory: [{ quantity: data.stock }] } : {}),
      },
    ];
  }

  if (data.attributes && data.attributes.length > 0) {
    body.product_attributes = data.attributes.map((a) => ({
      ...(a.id ? { id: a.id } : {}),
      values: (a.values ?? []).map((v) => ({
        ...(v.id ? { id: v.id } : {}),
        ...(v.name ? { name: v.name } : {}),
      })),
    }));
  }
  return body;
}

export interface StartDraftArgs {
  platform: Platform;
  tenantId: Uuid;
  shopId: string;
  initial: ProductDraftInput;
  /** When started from Discord, pass tool context so imageUrls use signed attachment links. */
  toolContext?: ToolContextLike;
}

export async function startDraft(args: StartDraftArgs): Promise<ProductDraftRecord> {
  if (args.platform === 'tiktok') {
    const shop = await resolveTiktokShop({ tenantId: args.tenantId, shopId: args.shopId });
    const conns = await listConnectionsByTenant(args.tenantId, ['tiktok']);
    const conn = findTiktokConnectionForToolShopId(conns, args.shopId);
    const shopCurrency = conn ? resolveTiktokShopCurrency(conn, args.shopId) : null;
    const uploaded = await eagerUploadImages(
      args.initial,
      'tiktok',
      shop.externalShopId,
      shop.shopCipher,
      args.toolContext,
    );
    const client = await getTiktokClient(shop.externalShopId);
    const { productId } = await saveTiktokDraft(
      client,
      buildTiktokDraftBody(uploaded, shopCurrency),
      shop.shopCipher,
    );
    return {
      draftId: buildTiktokDraftId(productId),
      platform: 'tiktok',
      tenantId: args.tenantId,
      shopId: shop.externalShopId,
      shopCipher: shop.shopCipher,
      status: 'open',
      data: uploaded,
      updatedAt: new Date().toISOString(),
      nativeDraft: true,
    };
  }

  const { marketplaceConnectionId, externalShopId } = await resolveShopeeConnectionIdAndShop(
    args.tenantId,
    args.shopId,
  );
  const uploaded = await eagerUploadImages(args.initial, 'shopee', externalShopId, undefined, args.toolContext);
  const row = await insertShopeeDraft({
    tenantId: args.tenantId,
    externalShopId,
    marketplaceConnectionId,
    data: uploaded,
  });
  return shopeeRowToRecord(row);
}

function shopeeRowToRecord(row: ShopeeDraftRow): ProductDraftRecord {
  return {
    draftId: buildShopeeDraftId(row.id),
    platform: 'shopee',
    tenantId: row.tenant_id,
    shopId: row.external_shop_id,
    status: row.status,
    data: (row.data ?? {}) as ProductDraftInput,
    publishedItemId: row.published_item_id ?? undefined,
    updatedAt: row.updated_at,
    nativeDraft: false,
  };
}

export interface UpdateDraftArgs {
  draftId: string;
  tenantId: Uuid;
  patch: ProductDraftInput;
  toolContext?: ToolContextLike;
}

function mergeDraftData(existing: ProductDraftInput, patch: ProductDraftInput): ProductDraftInput {
  const merged: ProductDraftInput = { ...existing, ...patch };
  // imageUrls in the patch always replace (caller is expected to send the desired set).
  if (patch.imageUrls === undefined) {
    merged.imageUrls = existing.imageUrls;
  }
  if (patch.images === undefined) {
    merged.images = existing.images;
  }
  if (patch.variants === undefined) {
    merged.variants = existing.variants;
  }
  return merged;
}

export async function updateDraft(args: UpdateDraftArgs): Promise<ProductDraftRecord> {
  const parsed = parseDraftId(args.draftId);
  if (parsed.platform === 'tiktok') {
    return updateTiktokDraft(parsed.rawId, args.tenantId, args.patch, args.toolContext);
  }
  return updateShopeeDraft(parsed.rawId, args.tenantId, args.patch, args.toolContext);
}

async function updateTiktokDraft(
  productId: string,
  tenantId: Uuid,
  patch: ProductDraftInput,
  toolContext?: ToolContextLike,
): Promise<ProductDraftRecord> {
  const current = await getTiktokDraft(productId, tenantId);
  const merged = mergeDraftData(current.data, patch);
  const uploaded = await eagerUploadImages(
    merged,
    'tiktok',
    current.shopId,
    current.shopCipher,
    toolContext,
  );
  const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
  const conn = findTiktokConnectionForToolShopId(conns, current.shopCipher ?? current.shopId);
  const shopCurrency = conn ? resolveTiktokShopCurrency(conn, current.shopCipher ?? current.shopId) : null;
  const client = await getTiktokClient(current.shopId);
  await partialEditTiktokProduct(
    client,
    productId,
    buildTiktokDraftBody(uploaded, shopCurrency),
    current.shopCipher ?? '',
  );
  // Refresh from TikTok so the record reflects platform-side state.
  return getTiktokDraft(productId, tenantId, uploaded);
}

async function updateShopeeDraft(
  id: string,
  tenantId: Uuid,
  patch: ProductDraftInput,
  toolContext?: ToolContextLike,
): Promise<ProductDraftRecord> {
  const row = await getShopeeDraftById(id, tenantId);
  if (!row) throw new Error(`Shopee draft ${id} not found.`);
  if (row.status !== 'open') {
    throw new Error(`Shopee draft ${id} is ${row.status}; updates are no longer accepted.`);
  }
  const merged = mergeDraftData((row.data ?? {}) as ProductDraftInput, patch);
  const uploaded = await eagerUploadImages(merged, 'shopee', row.external_shop_id, undefined, toolContext);
  const updated = await patchShopeeDraftData(id, tenantId, uploaded);
  return shopeeRowToRecord(updated);
}

/**
 * Fetch a draft (TikTok via API, Shopee via Supabase). For TikTok, when
 * `localData` is provided it is preferred over reconstructing from the
 * platform response (which lossy-converts our richer agent-side schema).
 */
async function getTiktokDraft(
  productId: string,
  tenantId: Uuid,
  localData?: ProductDraftInput,
): Promise<ProductDraftRecord> {
  const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
  let lastErr: Error | null = null;
  for (const conn of conns) {
    const ciphers = tiktokCipherPriorityList(conn, conn.external_shop_id);
    if (ciphers.length === 0) continue;
    const client = await getTiktokClient(conn.external_shop_id);
    for (const cipher of ciphers) {
      try {
        const detail = await getTiktokProductDetail(client, productId, cipher);
        if (!detail) continue;
        return {
          draftId: buildTiktokDraftId(productId),
          platform: 'tiktok',
          tenantId,
          shopId: conn.external_shop_id,
          shopCipher: cipher,
          status: detail.platformStatus === TIKTOK_STATUS_DRAFT ? 'open' : 'published',
          data: localData ?? convertDetailToDraftInput(detail),
          updatedAt: new Date().toISOString(),
          nativeDraft: true,
        };
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`TikTok draft ${productId} not found on any tenant connection.`);
}

function convertDetailToDraftInput(
  detail: import('./products').NormalizedProductDetail,
): ProductDraftInput {
  const images = (detail.imageUris ?? []).map((uri, idx) => ({
    sourceUrl: detail.imageUrls?.[idx] ?? `tiktok://${uri}`,
    tiktokUri: uri,
    tiktokUrl: detail.imageUrls?.[idx],
  }));
  return {
    title: detail.title,
    description: detail.description,
    categoryId: detail.categoryId,
    brandId: detail.brandId,
    weightGrams: detail.weightGrams,
    dimensionsCm: detail.dimensionsCm,
    images,
    variants: detail.variants.map((v) => ({
      sellerSku: v.sellerSku,
      attributes: v.attributes,
      price: v.price,
      stock: v.stock,
      imageUrl: v.imageUrl,
    })),
    price: detail.variants[0]?.price,
    stock: detail.variants[0]?.stock,
    attributes: detail.attributes,
  };
}

export async function getDraft(
  draftId: string,
  tenantId: Uuid,
): Promise<ProductDraftRecord> {
  const parsed = parseDraftId(draftId);
  if (parsed.platform === 'tiktok') {
    return getTiktokDraft(parsed.rawId, tenantId);
  }
  const row = await getShopeeDraftById(parsed.rawId, tenantId);
  if (!row) throw new Error(`Shopee draft ${parsed.rawId} not found.`);
  return shopeeRowToRecord(row);
}

export interface ListDraftsArgs {
  tenantId: Uuid;
  platforms?: Platform[];
  shopId?: string;
}

export interface ListDraftsResult {
  drafts: ProductDraftRecord[];
  errors: Array<{ platform: Platform; message: string }>;
}

export async function listDrafts(args: ListDraftsArgs): Promise<ListDraftsResult> {
  const platforms = args.platforms ?? (['shopee', 'tiktok'] as Platform[]);
  const drafts: ProductDraftRecord[] = [];
  const errors: ListDraftsResult['errors'] = [];

  await Promise.allSettled([
    (async () => {
      if (!platforms.includes('shopee')) return;
      try {
        const rows = await listShopeeDrafts(args.tenantId, {
          externalShopId: args.shopId,
          status: 'open',
        });
        for (const row of rows) drafts.push(shopeeRowToRecord(row));
      } catch (e) {
        errors.push({ platform: 'shopee', message: e instanceof Error ? e.message : String(e) });
      }
    })(),
    (async () => {
      if (!platforms.includes('tiktok')) return;
      try {
        const conns = await listConnectionsByTenant(args.tenantId, ['tiktok']);
        const filtered = args.shopId
          ? conns.filter((c) => c.external_shop_id === args.shopId || tiktokCipherPriorityList(c).includes(args.shopId!))
          : conns;
        for (const conn of filtered) {
          const ciphers = tiktokCipherPriorityList(conn, args.shopId);
          if (ciphers.length === 0) continue;
          const client = await getTiktokClient(conn.external_shop_id);
          for (const cipher of ciphers) {
            try {
              const rows = await listTiktokDraftProducts(client, cipher, 50);
              for (const row of rows) {
                drafts.push({
                  draftId: buildTiktokDraftId(row.productId),
                  platform: 'tiktok',
                  tenantId: args.tenantId,
                  shopId: conn.external_shop_id,
                  shopCipher: cipher,
                  status: 'open',
                  data: { title: row.title || undefined },
                  updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
                  nativeDraft: true,
                });
              }
            } catch (e) {
              errors.push({ platform: 'tiktok', message: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      } catch (e) {
        errors.push({ platform: 'tiktok', message: e instanceof Error ? e.message : String(e) });
      }
    })(),
  ]);

  drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { drafts, errors };
}

/** Discard a draft (TikTok: delete the draft product; Shopee: mark row discarded). */
export async function discardDraft(draftId: string, tenantId: Uuid): Promise<void> {
  const parsed = parseDraftId(draftId);
  if (parsed.platform === 'tiktok') {
    const record = await getTiktokDraft(parsed.rawId, tenantId);
    const { deleteTiktokProducts } = await import('../tiktok/product-write');
    const client = await getTiktokClient(record.shopId);
    await deleteTiktokProducts(client, [parsed.rawId], record.shopCipher ?? '');
    return;
  }
  await markShopeeDraftDiscarded(parsed.rawId, tenantId);
}

/**
 * Validate that a draft has the minimum fields each platform requires to
 * publish. Returns the list of missing field paths so the agent can ask the
 * user for them one by one.
 */
export function evaluateDraftReadiness(record: ProductDraftRecord): DraftReadiness {
  const missing: string[] = [];
  const d = record.data;
  if (!d.title) missing.push('title');
  if (!d.categoryId) missing.push('categoryId');

  const hasImages =
    (d.images && d.images.length > 0)
    || (d.imageUrls && d.imageUrls.length > 0);
  if (!hasImages) missing.push('imageUrls (or images)');

  const variants = d.variants ?? [];
  if (variants.length > 0) {
    variants.forEach((v, idx) => {
      if (typeof v.price !== 'number') missing.push(`variants[${idx}].price`);
      if (typeof v.stock !== 'number') missing.push(`variants[${idx}].stock`);
    });
  } else {
    if (typeof d.price !== 'number') missing.push('price');
    if (typeof d.stock !== 'number') missing.push('stock');
  }

  if (record.platform === 'shopee') {
    if (typeof d.weightGrams !== 'number') missing.push('weightGrams');
    if (!d.shopeeLogistics || d.shopeeLogistics.length === 0) missing.push('shopeeLogistics');
  }
  if (record.platform === 'tiktok') {
    if (typeof d.weightGrams !== 'number') missing.push('weightGrams (package_weight)');
  }

  return { ready: missing.length === 0, missing };
}
