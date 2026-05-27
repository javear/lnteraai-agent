import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireProductToolShopId,
  requireTenantContext,
  resolveShopeeToolShop,
  resolveTiktokToolShop,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import { getShopeeProductDetail } from '../../integrations/shopee/product-write';
import { getTiktokProductDetail } from '../../integrations/tiktok/product-write';
import type { NormalizedProductDetail } from '../../integrations/shared/products';

const platformEnum = z.enum(['shopee', 'tiktok']);

const getProductDetailsParamsSchema = z
  .object({
    platform: platformEnum,
    productId: z.string().min(1),
    shopId: z.string().min(1),
    includeRaw: z.boolean(),
  })
  .partial()
  .passthrough();

const getProductDetailsInputSchema = z.record(z.string(), z.unknown());

function widenGetProductDetailsInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  if (base.productId == null && typeof base.product_id === 'string') base.productId = base.product_id;
  if (base.shopId == null && typeof base.shop_id === 'string') base.shopId = base.shop_id;
  return base;
}

function parseGetProductDetailsArgs(input: unknown): z.infer<typeof getProductDetailsParamsSchema> & {
  platform: z.infer<typeof platformEnum>;
  productId: string;
} {
  const parsed = getProductDetailsParamsSchema.safeParse(widenGetProductDetailsInput(input));
  if (!parsed.success) {
    throw new Error(`Invalid get-product-details input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!parsed.data.platform || !parsed.data.productId) {
    throw new Error('Invalid get-product-details input: platform and productId are required.');
  }
  requireProductToolShopId(parsed.data.shopId);
  return parsed.data as z.infer<typeof getProductDetailsParamsSchema> & {
    platform: z.infer<typeof platformEnum>;
    productId: string;
    shopId: string;
  };
}

export const getProductDetailsTool = createTool({
  id: 'get-product-details',
  strict: false,
  description:
    'Fetch the full normalized detail for ONE product (title, description, status, category, brand, images, package weight/dimensions, attributes, variant SKUs with price/stock). **Input:** `{ platform, productId, shopId, includeRaw? }`. **shopId** is required — use the `shopId` from **search-products** on the same row. Use `variants[].skuId` for price/stock updates. Set `includeRaw: true` only when debugging.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: getProductDetailsInputSchema,
  inputExamples: [
    { input: { platform: 'shopee', productId: '12345678', shopId: '999111' } },
    { input: { platform: 'tiktok', productId: '1729012345678901234', shopId: '7123456789' } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseGetProductDetailsArgs(input);
    const includeRaw = args.includeRaw === true;

    const shopId = requireProductToolShopId(args.shopId);

    if (args.platform === 'shopee') {
      const conns = await listConnectionsByTenant(tenantId, ['shopee']);
      const resolved = resolveShopeeToolShop(conns, shopId);
      if ('error' in resolved) return { success: false, message: resolved.error };
      const client = await getShopeeClient(resolved.conn.external_shop_id);
      try {
        const detail = await getShopeeProductDetail(client, args.productId);
        if (!detail) {
          return { success: false, message: `Shopee product ${args.productId} not found on shop "${shopId}".` };
        }
        return { success: true, product: stripRaw(detail, includeRaw) };
      } catch (e) {
        return {
          success: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
    const resolved = resolveTiktokToolShop(conns, shopId);
    if ('error' in resolved) return { success: false, message: resolved.error };
    const client = await getTiktokClient(resolved.conn.external_shop_id);
    try {
      const detail = await getTiktokProductDetail(client, args.productId, resolved.shopCipher);
      if (!detail) {
        return { success: false, message: `TikTok product ${args.productId} not found on shop "${shopId}".` };
      }
      return { success: true, product: stripRaw(detail, includeRaw) };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
});

function stripRaw(detail: NormalizedProductDetail, includeRaw: boolean): NormalizedProductDetail {
  if (includeRaw) return detail;
  const { raw: _omit, ...rest } = detail;
  return rest as NormalizedProductDetail;
}
