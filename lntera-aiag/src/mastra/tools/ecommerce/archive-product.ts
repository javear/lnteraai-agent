import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireProductToolShopId,
  requireTenantContext,
  resolveShopeeToolShop,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { tryTiktokShopCipherLoop } from '../../integrations/shared/tiktok-shop-scope';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import {
  deleteShopeeItem,
  getShopeeProductDetail,
  unlistShopeeItem,
  listShopeeItem,
} from '../../integrations/shopee/product-write';
import {
  activateTiktokProducts,
  deactivateTiktokProducts,
  deleteTiktokProducts,
  getTiktokProductDetail,
  recoverTiktokProducts,
} from '../../integrations/tiktok/product-write';
import {
  isToolConfirmationRequired,
  assertConfirmed,
  TOOL_TWO_STEP_CONFIRM_DESC,
} from '../../integrations/shared/confirm';

const platformEnum = z.enum(['shopee', 'tiktok']);
const actionEnum = z.enum(['unlist', 'list', 'deactivate', 'activate', 'recover', 'delete']);

const archiveProductParamsSchema = z
  .object({
    platform: platformEnum,
    productId: z.string().min(1),
    shopId: z.string().min(1),
    action: actionEnum,
    confirm: z.boolean(),
  })
  .partial()
  .passthrough();

const archiveProductInputSchema = z.record(z.string(), z.unknown());

type ArchiveProductArgs = z.infer<typeof archiveProductParamsSchema> & {
  platform: z.infer<typeof platformEnum>;
  productId: string;
  action: z.infer<typeof actionEnum>;
};

function widenArchiveProductInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  if (base.productId == null && typeof base.product_id === 'string') base.productId = base.product_id;
  if (base.shopId == null && typeof base.shop_id === 'string') base.shopId = base.shop_id;
  return base;
}

function parseArchiveProductArgs(input: unknown): ArchiveProductArgs {
  const parsed = archiveProductParamsSchema.safeParse(widenArchiveProductInput(input));
  if (!parsed.success) {
    throw new Error(`Invalid archive-product input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!parsed.data.action) {
    throw new Error('Invalid archive-product input: action is required.');
  }
  if (!parsed.data.platform || !parsed.data.productId) {
    throw new Error('Invalid archive-product input: platform and productId are required.');
  }
  requireProductToolShopId(parsed.data.shopId);
  return parsed.data as ArchiveProductArgs & { shopId: string };
}

const TOOL_ID = 'archive-product';

/** Map agent-facing actions to platform-specific verbs. */
function describeAction(platform: 'shopee' | 'tiktok', action: z.infer<typeof actionEnum>): string {
  if (platform === 'shopee') {
    if (action === 'unlist' || action === 'deactivate') return 'Unlist (hide from buyers; reversible).';
    if (action === 'list' || action === 'activate' || action === 'recover') return 'List the item back (make visible).';
    if (action === 'delete') return 'Permanently delete the item. **Irreversible.**';
  }
  if (platform === 'tiktok') {
    if (action === 'unlist' || action === 'deactivate') return 'Deactivate (hide from shoppers; reversible).';
    if (action === 'activate') return 'Activate the product.';
    if (action === 'recover') return 'Recover a deleted draft.';
    if (action === 'list') return 'Activate the product.';
    if (action === 'delete') return 'Delete the product. **Irreversible.**';
  }
  return action;
}

export const archiveProductTool = createTool({
  id: TOOL_ID,
  strict: false,
  description:
    `Hide, restore, or delete a product. ${TOOL_TWO_STEP_CONFIRM_DESC} shopId from search-products.`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: archiveProductInputSchema,
  inputExamples: [
    { input: { platform: 'shopee', productId: '12345', shopId: '999', action: 'unlist' } },
    { input: { platform: 'shopee', productId: '12345', shopId: '999', action: 'delete', confirm: true } },
    { input: { platform: 'tiktok', productId: '17290...', shopId: '7123', action: 'deactivate', confirm: true } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseArchiveProductArgs(input);

    try {
      const shopId = args.shopId!;

      if (args.platform === 'shopee') {
        const conns = await listConnectionsByTenant(tenantId, ['shopee']);
        const resolved = resolveShopeeToolShop(conns, shopId);
        if ('error' in resolved) return { success: false, message: resolved.error };
        const conn = resolved.conn;
        const client = await getShopeeClient(conn.external_shop_id);
        const detail = await getShopeeProductDetail(client, args.productId);
        if (!detail) {
          return { success: false, message: `Shopee item ${args.productId} not found.` };
        }
        assertConfirmed({
          confirm: args.confirm,
          toolId: TOOL_ID,
          preview: {
            platform: 'shopee',
            productId: detail.productId,
            shopId: conn.external_shop_id,
            title: detail.title,
            currentStatus: detail.platformStatus ?? detail.status,
            action: args.action,
            effect: describeAction('shopee', args.action),
          },
          message: `Confirm to ${describeAction('shopee', args.action)} Shopee item "${detail.title}" (${detail.productId}).`,
        });
        if (args.action === 'unlist' || args.action === 'deactivate') {
          await unlistShopeeItem(client, args.productId);
        } else if (args.action === 'list' || args.action === 'activate' || args.action === 'recover') {
          await listShopeeItem(client, args.productId);
        } else if (args.action === 'delete') {
          await deleteShopeeItem(client, args.productId);
        }
        return { success: true, message: `Shopee item ${args.productId}: ${args.action} done.` };
      }

      const conns = await listConnectionsByTenant(tenantId, ['tiktok']);
      if (conns.length === 0) {
        return { success: false, message: 'No TikTok connection found for tenant.' };
      }

      const previewAttempt = await tryTiktokShopCipherLoop({
        conns,
        shopIdHint: shopId,
        getClient: (conn) => getTiktokClient(conn.external_shop_id),
        run: async ({ client, shopCipher }) => {
          const detail = await getTiktokProductDetail(client, args.productId, shopCipher);
          if (!detail) {
            throw new Error(`TikTok product ${args.productId} not found for this shop scope.`);
          }
          return detail;
        },
      });
      if ('error' in previewAttempt) {
        return { success: false, message: previewAttempt.error };
      }
      const { value: detail, shopCipher, conn: tiktokConn } = previewAttempt;
      const client = await getTiktokClient(tiktokConn.external_shop_id);

      assertConfirmed({
        confirm: args.confirm,
        toolId: TOOL_ID,
        preview: {
          platform: 'tiktok',
          productId: detail.productId,
          shopId: shopCipher,
          title: detail.title,
          currentStatus: detail.platformStatus ?? detail.status,
          action: args.action,
          effect: describeAction('tiktok', args.action),
        },
        message: `Confirm to ${describeAction('tiktok', args.action)} TikTok product "${detail.title}" (${detail.productId}).`,
      });

      if (args.action === 'unlist' || args.action === 'deactivate') {
        await deactivateTiktokProducts(client, [args.productId], shopCipher);
      } else if (args.action === 'list' || args.action === 'activate') {
        await activateTiktokProducts(client, [args.productId], shopCipher);
      } else if (args.action === 'recover') {
        await recoverTiktokProducts(client, [args.productId], shopCipher);
      } else if (args.action === 'delete') {
        await deleteTiktokProducts(client, [args.productId], shopCipher);
      }
      return {
        success: true,
        message: `TikTok product ${args.productId}: ${args.action} done.`,
        shopId: shopCipher,
      };
    } catch (e) {
      if (isToolConfirmationRequired(e)) return e.payload;
      throw e;
    }
  },
});
