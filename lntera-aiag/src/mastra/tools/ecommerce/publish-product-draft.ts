import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  findTiktokConnectionForToolShopId,
  requireTenantContext,
  resolveTiktokShopCurrency,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import {
  evaluateDraftReadiness,
  getDraft,
  parseDraftId,
} from '../../integrations/shared/product-drafts';
import { getTiktokClient } from '../../integrations/tiktok/client';
import { getShopeeClient } from '../../integrations/shopee/client';
import {
  activateTiktokProducts,
  buildTiktokSkuPriceForApi,
  editTiktokProduct,
  getTiktokProductDetail,
} from '../../integrations/tiktok/product-write';
import {
  addShopeeItem,
  addShopeeModels,
  type ShopeeAddItemBody,
  type ShopeeAddModelInput,
} from '../../integrations/shopee/product-write';
import {
  isToolConfirmationRequired,
  assertConfirmed,
  TOOL_TWO_STEP_CONFIRM_DESC,
} from '../../integrations/shared/confirm';
import {
  markShopeeDraftPublished,
  recordShopeeDraftPublishError,
} from '../../integrations/shared/shopee-drafts';

const inputSchema = z
  .object({
    draftId: z.string().min(1),
    confirm: z.boolean().optional(),
    /** TikTok-only: when false, leaves the listing as DRAFT instead of activating. */
    activate: z.boolean().optional(),
  })
  .passthrough();

const TOOL_ID = 'publish-product-draft';

export const publishProductDraftTool = createTool({
  id: TOOL_ID,
  description:
    `Publish a draft to the marketplace. ${TOOL_TWO_STEP_CONFIRM_DESC} Preview includes title, price, variants, and missing fields. Fails fast with \`missing[]\` if required fields are unset — fix with **update-product-draft** and retry. **TikTok**: full edit then activate (\`activate: false\` keeps draft). **Shopee**: add_item (+ add_model when variants). **Input:** \`{ draftId, confirm?, activate? }\`.`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    { input: { draftId: 'tt-1729012345678901234' } },
    { input: { draftId: 'tt-1729012345678901234', confirm: true } },
    { input: { draftId: 'sp-123e4567-e89b-12d3-a456-426614174000', confirm: true } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});
    const parsed = parseDraftId(args.draftId);
    const record = await getDraft(args.draftId, tenantId);
    const readiness = evaluateDraftReadiness(record);
    if (!readiness.ready) {
      return {
        success: false,
        message: 'Draft is not ready to publish.',
        missing: readiness.missing,
        draftId: record.draftId,
      };
    }

    try {
      assertConfirmed({
        confirm: args.confirm,
        toolId: TOOL_ID,
        preview: {
          draftId: record.draftId,
          platform: record.platform,
          shopId: record.shopId,
          title: record.data.title,
          price: record.data.price,
          stock: record.data.stock,
          variantCount: record.data.variants?.length ?? 0,
          activate: args.activate ?? true,
        },
        message: `Confirm to publish ${record.platform} draft "${record.data.title}" to shop ${record.shopId}.`,
      });

      if (record.platform === 'tiktok') {
        if (!record.shopCipher) {
          return { success: false, message: 'TikTok draft is missing shop_cipher; cannot publish.' };
        }
        const client = await getTiktokClient(record.shopId);
        const detail = await getTiktokProductDetail(client, parsed.rawId, record.shopCipher);
        const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
        const conn = findTiktokConnectionForToolShopId(conns, record.shopCipher ?? record.shopId);
        const shopCurrency =
          detail?.variants[0]?.currency?.trim()
          ?? (conn ? resolveTiktokShopCurrency(conn, record.shopCipher ?? record.shopId) : null);
        // Reapply the full body via PUT so any fields that were rejected from
        // partial_edit get a second chance.
        const body = buildFullTiktokBody(record.data, shopCurrency);
        await editTiktokProduct(client, parsed.rawId, body, record.shopCipher);
        const shouldActivate = args.activate !== false;
        if (shouldActivate) {
          await activateTiktokProducts(client, [parsed.rawId], record.shopCipher);
        }
        return {
          success: true,
          draftId: record.draftId,
          productId: parsed.rawId,
          platform: 'tiktok',
          activated: shouldActivate,
          message: shouldActivate
            ? `Published TikTok product ${parsed.rawId} (activation requested).`
            : `Saved TikTok draft ${parsed.rawId} (kept as DRAFT).`,
        };
      }

      const client = await getShopeeClient(record.shopId);
      const body = buildShopeeAddItemBody(record.data);
      const { itemId } = await addShopeeItem(client, body);
      if (record.data.variants && record.data.variants.length > 0 && record.data.variantTiers) {
        const tiers = record.data.variantTiers;
        const models: ShopeeAddModelInput[] = record.data.variants.map((v) => ({
          tierIndex: v.tierIndex ?? [],
          price: typeof v.price === 'number' ? v.price : record.data.price ?? 0,
          stock: v.stock,
          sellerSku: v.sellerSku,
        }));
        await addShopeeModels(client, itemId, tiers, models);
      }
      await markShopeeDraftPublished(parsed.rawId, tenantId, itemId);
      return {
        success: true,
        draftId: record.draftId,
        productId: itemId,
        platform: 'shopee',
        message: `Published Shopee item ${itemId}.`,
      };
    } catch (e) {
      if (isToolConfirmationRequired(e)) return e.payload;
      if (record.platform === 'shopee') {
        const msg = e instanceof Error ? e.message : String(e);
        await recordShopeeDraftPublishError(parsed.rawId, tenantId, msg).catch(() => undefined);
      }
      throw e;
    }
  },
});

function tiktokPublishSkuPrice(
  amount: number,
  currency: string | null | undefined,
): Record<string, string> | undefined {
  if (!currency?.trim()) return undefined;
  return buildTiktokSkuPriceForApi(amount, currency);
}

function buildFullTiktokBody(
  data: import('../../integrations/shared/product-drafts').ProductDraftInput,
  shopCurrency?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: data.title,
    description: data.description ?? '',
    category_id: data.categoryId,
  };
  if (data.brandId) body.brand_id = data.brandId;
  const uris = (data.images ?? []).map((i) => i.tiktokUri).filter(Boolean) as string[];
  body.main_images = uris.map((uri) => ({ uri }));
  if (typeof data.weightGrams === 'number') {
    body.package_weight = { value: String(data.weightGrams), unit: 'GRAM' };
  }
  if (data.dimensionsCm) {
    const d = data.dimensionsCm;
    body.package_dimensions = {
      length: d.length != null ? String(d.length) : '0',
      width: d.width != null ? String(d.width) : '0',
      height: d.height != null ? String(d.height) : '0',
      unit: 'CENTIMETER',
    };
  }
  if (data.variants && data.variants.length > 0) {
    body.skus = data.variants.map((v) => ({
      ...(v.sellerSku ? { seller_sku: v.sellerSku } : {}),
      ...(v.attributes && v.attributes.length > 0
        ? { sales_attributes: v.attributes.map((a) => ({ name: a.name, value_name: a.value })) }
        : {}),
      ...(typeof v.price === 'number' ? { price: tiktokPublishSkuPrice(v.price, shopCurrency) } : {}),
      ...(typeof v.stock === 'number' ? { inventory: [{ quantity: v.stock }] } : {}),
    }));
  } else {
    body.skus = [
      {
        ...(typeof data.price === 'number'
          ? { price: tiktokPublishSkuPrice(data.price, shopCurrency) }
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

function buildShopeeAddItemBody(
  data: import('../../integrations/shared/product-drafts').ProductDraftInput,
): ShopeeAddItemBody {
  if (!data.title || !data.description || !data.categoryId) {
    throw new Error('Shopee draft missing title/description/categoryId — readiness check failed unexpectedly.');
  }
  if (typeof data.weightGrams !== 'number') {
    throw new Error('Shopee draft missing weightGrams.');
  }
  if (!data.shopeeLogistics || data.shopeeLogistics.length === 0) {
    throw new Error('Shopee draft missing logistics; configure at least one shipping channel.');
  }
  const imageIds = (data.images ?? []).map((i) => i.shopeeImageId).filter(Boolean) as string[];
  if (imageIds.length === 0) {
    throw new Error('Shopee draft missing uploaded images; add at least one image URL first.');
  }
  // Shopee API expects price as the "original_price" of the base item; for
  // variant items, this is overridden by /add_model rows.
  const basePrice = typeof data.price === 'number'
    ? data.price
    : data.variants?.find((v) => typeof v.price === 'number')?.price ?? 0;

  const body: ShopeeAddItemBody = {
    original_price: basePrice,
    description: data.description,
    item_name: data.title,
    weight: data.weightGrams / 1000,
    category_id: Number(data.categoryId),
    image: { image_id_list: imageIds },
    logistic_info: data.shopeeLogistics,
  };
  if (data.brandId) body.brand = { brand_id: Number(data.brandId) };
  if (data.dimensionsCm && (data.dimensionsCm.length || data.dimensionsCm.width || data.dimensionsCm.height)) {
    body.dimension = {
      package_length: data.dimensionsCm.length ?? 0,
      package_width: data.dimensionsCm.width ?? 0,
      package_height: data.dimensionsCm.height ?? 0,
    };
  }
  if (data.attributes && data.attributes.length > 0) {
    body.attribute_list = data.attributes.map((a) => ({
      attribute_id: Number(a.id ?? 0),
      attribute_value_list: (a.values ?? []).map((v) => ({
        value_id: v.id != null ? Number(v.id) : undefined,
        original_value_name: v.name,
      })),
    }));
  }
  // Non-variant draft: set seller_stock on the base item.
  if ((!data.variants || data.variants.length === 0) && typeof data.stock === 'number') {
    body.seller_stock = [{ stock: data.stock }];
  }
  return body;
}
