import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireProductToolShopId,
  requireTenantContext,
  resolveShopeeToolShop,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { TiktokToolError, tryTiktokShopCipherLoop } from '../../integrations/shared/tiktok-shop-scope';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import {
  getShopeeProductDetail,
  updateShopeePrices,
  type ShopeeModelUpdate,
} from '../../integrations/shopee/product-write';
import {
  getTiktokProductDetail,
  updateTiktokPrices,
  type TiktokSkuPriceUpdate,
} from '../../integrations/tiktok/product-write';

const platformEnum = z.enum(['shopee', 'tiktok']);

const skuUpdateSchema = z.object({
  skuId: z.string().min(1),
  price: z.number().nonnegative(),
});

const updateProductPriceParamsSchema = z
  .object({
    platform: platformEnum,
    productId: z.string().min(1),
    shopId: z.string().min(1),
    /** Either set `price` (single SKU) OR `updates` (per-variant). */
    price: z.number().nonnegative(),
    updates: z.array(skuUpdateSchema),
  })
  .partial()
  .passthrough();

const updateProductPriceInputSchema = z.record(z.string(), z.unknown());

type UpdateProductPriceArgs = z.infer<typeof updateProductPriceParamsSchema> & {
  platform: z.infer<typeof platformEnum>;
  productId: string;
};

function widenUpdateProductPriceInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  if (base.productId == null && typeof base.product_id === 'string') {
    base.productId = base.product_id;
  }
  if (base.shopId == null && typeof base.shop_id === 'string') {
    base.shopId = base.shop_id;
  }
  return base;
}

function parseUpdateProductPriceArgs(input: unknown): UpdateProductPriceArgs {
  const parsed = updateProductPriceParamsSchema.safeParse(widenUpdateProductPriceInput(input));
  if (!parsed.success) {
    throw new Error(
      `Invalid update-product-price input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  if (!parsed.data.platform || !parsed.data.productId) {
    throw new Error('Invalid update-product-price input: platform and productId are required.');
  }
  requireProductToolShopId(parsed.data.shopId);
  return parsed.data as UpdateProductPriceArgs & { shopId: string };
}

export const updateProductPriceTool = createTool({
  id: 'update-product-price',
  strict: false,
  description:
    'Update price. Non-variant: price. Variant: updates[{ skuId, price }]. shopId from search-products.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: updateProductPriceInputSchema,
  inputExamples: [
    { input: { platform: 'shopee', productId: '12345', shopId: '999', price: 49000 } },
    {
      input: {
        platform: 'tiktok',
        productId: '17290...',
        shopId: '7123',
        updates: [{ skuId: 'sku1', price: 89000 }, { skuId: 'sku2', price: 99000 }],
      },
    },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseUpdateProductPriceArgs(input);
    if (args.price != null && args.updates && args.updates.length > 0) {
      return { success: false, message: 'Pass either `price` (single SKU) or `updates` (variant array), not both.' };
    }
    if (args.price == null && (!args.updates || args.updates.length === 0)) {
      return { success: false, message: 'Provide `price` (single SKU) or non-empty `updates` (variant array).' };
    }

    const shopId = args.shopId!;

    if (args.platform === 'shopee') {
      const conns = await listConnectionsByTenant(tenantId, ['shopee']);
      const resolved = resolveShopeeToolShop(conns, shopId);
      if ('error' in resolved) return { success: false, message: resolved.error };
      const conn = resolved.conn;
      const client = await getShopeeClient(conn.external_shop_id);
      let modelUpdates: ShopeeModelUpdate[] = [];
      if (args.updates && args.updates.length > 0) {
        modelUpdates = args.updates.map((u) => ({ modelId: Number(u.skuId), price: u.price }));
      } else {
        const detail = await getShopeeProductDetail(client, args.productId);
        if (!detail) return { success: false, message: `Shopee item ${args.productId} not found.` };
        if (detail.hasVariants) {
          return {
            success: false,
            message: 'Product has variants; pass `updates: [{ skuId, price }]` instead of `price`.',
          };
        }
        // Non-variant items: Shopee accepts model_id = 0.
        modelUpdates = [{ modelId: 0, price: args.price! }];
      }
      await updateShopeePrices(client, args.productId, modelUpdates);
      return { success: true, message: `Shopee item ${args.productId} prices updated.`, count: modelUpdates.length };
    }

    const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
    if (conns.length === 0) {
      return { success: false, message: 'No TikTok connection found for tenant.' };
    }

    const attempt = await tryTiktokShopCipherLoop({
      conns,
      shopIdHint: shopId,
      getClient: (conn) => getTiktokClient(conn.external_shop_id),
      run: async ({ client, shopCipher }) => {
        const detail = await getTiktokProductDetail(client, args.productId, shopCipher);
        if (!detail) {
          throw new Error(`TikTok product ${args.productId} not found for this shop scope.`);
        }
        if (detail.variants.length === 0) {
          throw new TiktokToolError('TikTok product has no SKUs; cannot update price.');
        }

        const variantBySku = new Map(detail.variants.map((v) => [v.skuId, v]));

        const toTiktokUpdate = (skuId: string, price: number): TiktokSkuPriceUpdate => {
          const variant = variantBySku.get(skuId);
          if (!variant) {
            throw new TiktokToolError(`SKU "${skuId}" not found on TikTok product ${args.productId}.`);
          }
          if (!variant.currency?.trim()) {
            throw new TiktokToolError(
              `SKU "${skuId}" is missing currency on TikTok — re-fetch product details before updating price.`,
            );
          }
          return {
            skuId,
            price,
            currency: variant.currency.trim(),
            existingPrice: variant.tiktokPriceFields
              ? {
                  sale_price: variant.tiktokPriceFields.salePrice,
                  tax_exclusive_price: variant.tiktokPriceFields.taxExclusivePrice,
                  currency: variant.currency,
                }
              : { currency: variant.currency },
          };
        };

        let tiktokUpdates: TiktokSkuPriceUpdate[] = [];
        if (args.updates && args.updates.length > 0) {
          tiktokUpdates = args.updates.map((u) => toTiktokUpdate(u.skuId, u.price));
        } else {
          if (detail.hasVariants) {
            throw new TiktokToolError(
              'Product has variants; pass `updates: [{ skuId, price }]` listing each variant.',
            );
          }
          tiktokUpdates = [toTiktokUpdate(detail.variants[0].skuId, args.price!)];
        }

        await updateTiktokPrices(client, args.productId, tiktokUpdates, shopCipher);
        return tiktokUpdates.length;
      },
    });

    if ('error' in attempt) {
      return { success: false, message: attempt.error };
    }
    return {
      success: true,
      message: `TikTok product ${args.productId} prices updated.`,
      count: attempt.value,
      shopId: attempt.shopCipher,
    };
  },
});
