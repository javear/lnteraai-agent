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
  updateShopeeStock,
  type ShopeeModelUpdate,
} from '../../integrations/shopee/product-write';
import {
  getTiktokProductDetail,
  updateTiktokInventory,
  type TiktokSkuInventoryUpdate,
} from '../../integrations/tiktok/product-write';

const platformEnum = z.enum(['shopee', 'tiktok']);

const skuUpdateSchema = z.object({
  skuId: z.string().min(1),
  stock: z.number().int().nonnegative(),
  warehouseId: z.string().min(1).optional(),
});

const updateProductStockParamsSchema = z
  .object({
    platform: platformEnum,
    productId: z.string().min(1),
    shopId: z.string().min(1),
    /** Either set `stock` (single SKU) OR `updates` (per-variant). */
    stock: z.number().int().nonnegative(),
    updates: z.array(skuUpdateSchema),
  })
  .partial()
  .passthrough();

/** Groq: avoid listing optional keys in `properties` — they become required at validation time. */
const updateProductStockInputSchema = z.record(z.string(), z.unknown());

type UpdateProductStockArgs = z.infer<typeof updateProductStockParamsSchema> & {
  platform: z.infer<typeof platformEnum>;
  productId: string;
};

function widenUpdateProductStockInput(input: unknown): Record<string, unknown> {
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

function parseUpdateProductStockArgs(input: unknown): UpdateProductStockArgs {
  const parsed = updateProductStockParamsSchema.safeParse(widenUpdateProductStockInput(input));
  if (!parsed.success) {
    throw new Error(
      `Invalid update-product-stock input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  if (!parsed.data.platform || !parsed.data.productId) {
    throw new Error('Invalid update-product-stock input: platform and productId are required.');
  }
  requireProductToolShopId(parsed.data.shopId);
  return parsed.data as UpdateProductStockArgs & { shopId: string };
}

export const updateProductStockTool = createTool({
  id: 'update-product-stock',
  /** Groq: strict tool input forces all schema properties to be sent; disable for optional filters. */
  strict: false,
  description:
    'Update product stock / inventory quantity (set absolute). Non-variant: stock. Variant: updates[{ skuId, stock }]. shopId from search-products.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: updateProductStockInputSchema,
  inputExamples: [
    { input: { platform: 'shopee', productId: '12345', shopId: '999', stock: 25 } },
    {
      input: {
        platform: 'tiktok',
        productId: '17290...',
        shopId: '7123',
        updates: [{ skuId: 'sku1', stock: 10 }, { skuId: 'sku2', stock: 4 }],
      },
    },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseUpdateProductStockArgs(input);
    if (args.stock != null && args.updates && args.updates.length > 0) {
      return { success: false, message: 'Pass either `stock` (single SKU) or `updates` (variant array), not both.' };
    }
    if (args.stock == null && (!args.updates || args.updates.length === 0)) {
      return { success: false, message: 'Provide `stock` (single SKU) or non-empty `updates` (variant array).' };
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
        modelUpdates = args.updates.map((u) => ({ modelId: Number(u.skuId), stock: u.stock }));
      } else {
        const detail = await getShopeeProductDetail(client, args.productId);
        if (!detail) return { success: false, message: `Shopee item ${args.productId} not found.` };
        if (detail.hasVariants) {
          return {
            success: false,
            message: 'Product has variants; pass `updates: [{ skuId, stock }]` instead of `stock`.',
          };
        }
        modelUpdates = [{ modelId: 0, stock: args.stock! }];
      }
      await updateShopeeStock(client, args.productId, modelUpdates);
      return { success: true, message: `Shopee item ${args.productId} stock updated.`, count: modelUpdates.length };
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
        let tiktokUpdates: TiktokSkuInventoryUpdate[] = [];
        if (args.updates && args.updates.length > 0) {
          tiktokUpdates = args.updates.map((u) => ({
            skuId: u.skuId,
            quantity: u.stock,
            warehouseId: u.warehouseId,
          }));
        } else {
          const detail = await getTiktokProductDetail(client, args.productId, shopCipher);
          if (!detail) {
            throw new Error(`TikTok product ${args.productId} not found for this shop scope.`);
          }
          if (detail.variants.length === 0) {
            throw new TiktokToolError('TikTok product has no SKUs; cannot update stock.');
          }
          if (detail.hasVariants) {
            throw new TiktokToolError(
              'Product has variants; pass `updates: [{ skuId, stock }]` listing each variant.',
            );
          }
          const sku = detail.variants[0];
          tiktokUpdates = [{ skuId: sku.skuId, quantity: args.stock! }];
        }
        await updateTiktokInventory(client, args.productId, tiktokUpdates, shopCipher);
        return tiktokUpdates.length;
      },
    });

    if ('error' in attempt) {
      return { success: false, message: attempt.error };
    }
    return {
      success: true,
      message: `TikTok product ${args.productId} stock updated.`,
      count: attempt.value,
      shopId: attempt.shopCipher,
    };
  },
});
