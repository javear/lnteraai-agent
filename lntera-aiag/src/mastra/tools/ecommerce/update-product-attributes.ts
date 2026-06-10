import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireProductToolShopId,
  requireTenantContext,
  resolveShopeeToolShop,
  resolveTiktokToolShop,
  tiktokConnectionHasProductWrite,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import { updateShopeeItem } from '../../integrations/shopee/product-write';
import { getTiktokProductDetail, partialEditTiktokProduct } from '../../integrations/tiktok/product-write';
import {
  DISCORD_IMAGE_URL_TOOL_HINT,
  resolveImageUrlsForProductTool,
  type ToolContextLike,
} from '../../integrations/shared/discord-attachment-urls';
import { uploadProductImageFromUrl } from '../../integrations/shared/product-images';

const platformEnum = z.enum(['shopee', 'tiktok']);

const attributeValueSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});

const updateProductAttributesParamsSchema = z
  .object({
    platform: platformEnum,
    productId: z.string().min(1),
    shopId: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    categoryId: z.string(),
    brandId: z.string(),
    imageUrls: z.array(z.string().url()),
    weightGrams: z.number().int().positive(),
    dimensionsCm: z.object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    attributes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        values: z.array(attributeValueSchema),
      }),
    ),
  })
  .partial()
  .passthrough();

const updateProductAttributesInputSchema = z.record(z.string(), z.unknown());

type UpdateProductAttributesArgs = z.infer<typeof updateProductAttributesParamsSchema> & {
  platform: z.infer<typeof platformEnum>;
  productId: string;
};

function widenUpdateProductAttributesInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  if (base.productId == null && typeof base.product_id === 'string') base.productId = base.product_id;
  if (base.shopId == null && typeof base.shop_id === 'string') base.shopId = base.shop_id;
  return base;
}

function parseUpdateProductAttributesArgs(input: unknown): UpdateProductAttributesArgs {
  const parsed = updateProductAttributesParamsSchema.safeParse(widenUpdateProductAttributesInput(input));
  if (!parsed.success) {
    throw new Error(
      `Invalid update-product-attributes input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  if (!parsed.data.platform || !parsed.data.productId) {
    throw new Error('Invalid update-product-attributes input: platform and productId are required.');
  }
  requireProductToolShopId(parsed.data.shopId);
  return parsed.data as UpdateProductAttributesArgs & { shopId: string };
}

export const updateProductAttributesTool = createTool({
  id: 'update-product-attributes',
  strict: false,
  description:
    `Patch published product attributes (not price/stock). shopId from search-products. ${DISCORD_IMAGE_URL_TOOL_HINT}`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: updateProductAttributesInputSchema,
  inputExamples: [
    { input: { platform: 'shopee', productId: '12345', shopId: '999', title: 'New title' } },
    { input: { platform: 'tiktok', productId: '17290...', shopId: '7123', description: 'updated desc' } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseUpdateProductAttributesArgs(input);

    const shopId = args.shopId!;
    const imageUrls = resolveImageUrlsForProductTool(args.imageUrls, context as ToolContextLike);

    if (args.platform === 'shopee') {
      const conns = await listConnectionsByTenant(tenantId, ['shopee']);
      const resolved = resolveShopeeToolShop(conns, shopId);
      if ('error' in resolved) return { success: false, message: resolved.error };
      const conn = resolved.conn;
      const client = await getShopeeClient(conn.external_shop_id);

      const patch: Record<string, unknown> = {};
      if (args.title) patch.item_name = args.title;
      if (args.description) patch.description = args.description;
      if (args.categoryId) patch.category_id = Number(args.categoryId);
      if (args.brandId) patch.brand = { brand_id: Number(args.brandId) };
      if (typeof args.weightGrams === 'number') patch.weight = args.weightGrams / 1000;
      if (args.dimensionsCm) {
        patch.dimension = {
          package_length: args.dimensionsCm.length,
          package_width: args.dimensionsCm.width,
          package_height: args.dimensionsCm.height,
        };
      }
      if (imageUrls.length > 0) {
        const ids: string[] = [];
        for (const url of imageUrls) {
          const r = await uploadProductImageFromUrl({ platform: 'shopee', shopId: conn.external_shop_id, url });
          if (r.imageId) ids.push(r.imageId);
        }
        if (ids.length > 0) patch.image = { image_id_list: ids };
      }
      if (args.attributes && args.attributes.length > 0) {
        patch.attribute_list = args.attributes.map((a) => ({
          attribute_id: a.id != null ? Number(a.id) : undefined,
          attribute_value_list: (a.values ?? []).map((v) => ({
            value_id: v.id != null ? Number(v.id) : undefined,
            original_value_name: v.name,
          })),
        }));
      }
      if (Object.keys(patch).length === 0) {
        return { success: false, message: 'No attributes provided to update.' };
      }
      await updateShopeeItem(client, args.productId, patch);
      return { success: true, message: `Shopee item ${args.productId} updated.`, patched: Object.keys(patch) };
    }

    const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
    const resolved = resolveTiktokToolShop(conns, shopId);
    if ('error' in resolved) return { success: false, message: resolved.error };
    if (!tiktokConnectionHasProductWrite(resolved.conn)) {
      return {
        success: false,
        message:
          'This TikTok connection cannot edit products (missing seller.product.write). Re-authorize TikTok for this shop with product write scope.',
      };
    }
    const { conn, shopCipher } = resolved;
    const client = await getTiktokClient(conn.external_shop_id);
    let detail;
    try {
      detail = await getTiktokProductDetail(client, args.productId, shopCipher);
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (!detail) {
      return { success: false, message: `TikTok product ${args.productId} not found on shop "${shopId}".` };
    }
    const body: Record<string, unknown> = {};
    if (args.title) body.title = args.title;
    if (args.description) body.description = args.description;
    if (args.categoryId) body.category_id = args.categoryId;
    if (args.brandId) body.brand_id = args.brandId;
    if (typeof args.weightGrams === 'number') {
      body.package_weight = { value: String(args.weightGrams), unit: 'GRAM' };
    }
    if (args.dimensionsCm) {
      const d = args.dimensionsCm;
      body.package_dimensions = {
        length: d.length != null ? String(d.length) : '0',
        width: d.width != null ? String(d.width) : '0',
        height: d.height != null ? String(d.height) : '0',
        unit: 'CENTIMETER',
      };
    }
    if (imageUrls.length > 0) {
      const uris: string[] = [];
      for (const url of imageUrls) {
        const r = await uploadProductImageFromUrl({
          platform: 'tiktok',
          shopId: conn.external_shop_id,
          url,
          shopCipher,
        });
        if (r.uri) uris.push(r.uri);
      }
      if (uris.length > 0) {
        const existing = detail.imageUris ?? [];
        const merged =
          uris.length < existing.length && existing.length > 0
            ? [...uris, ...existing.slice(uris.length)]
            : uris;
        body.main_images = merged.map((uri) => ({ uri }));
      }
    }
    if (args.attributes && args.attributes.length > 0) {
      body.product_attributes = args.attributes.map((a) => ({
        ...(a.id ? { id: a.id } : {}),
        values: (a.values ?? []).map((v) => ({
          ...(v.id ? { id: v.id } : {}),
          ...(v.name ? { name: v.name } : {}),
        })),
      }));
    }
    if (Object.keys(body).length === 0) {
      return { success: false, message: 'No attributes provided to update.' };
    }
    await partialEditTiktokProduct(client, args.productId, body, shopCipher);
    return {
      success: true,
      message: `TikTok product ${args.productId} updated.`,
      patched: Object.keys(body),
      shopId: shopCipher,
    };
  },
});
