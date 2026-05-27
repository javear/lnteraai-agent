import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  findTiktokConnectionForToolShopId,
  requireTenantContext,
  tiktokCipherPriorityList,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import {
  buildPrepareShipmentSummary,
  type FulfillmentTarget,
  type PrepareShipmentResult,
} from '../../integrations/shared/fulfillment';
import { createTiktokFulfillmentPackages } from '../../integrations/tiktok/create-package';
import { prepareShopeeShipmentContext } from '../../integrations/shopee/prepare-shipment';

const platformEnum = z.enum(['shopee', 'tiktok']);

const orderElementSchema = z
  .object({
    id: z.string().min(1),
    platform: platformEnum,
  })
  .passthrough();

const inputSchema = z
  .object({
    orders: z.array(orderElementSchema).min(1),
  })
  .passthrough();

const argsSchema = z.object({
  orders: z
    .array(
      z.object({
        id: z.string().min(1),
        platform: platformEnum,
        shopId: z.string().min(1).nullable().optional(),
      }),
    )
    .min(1),
  includeRaw: z.boolean().nullable().optional(),
});

interface Args {
  orders: FulfillmentTarget[];
  includeRaw: boolean;
}

function parseArgs(input: unknown): Args {
  const parsed = argsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid create-fulfillment-package input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return {
    orders: parsed.data.orders.map((o) => {
      const sid = o.shopId?.trim();
      return {
        id: o.id.trim(),
        platform: o.platform,
        ...(sid ? { shopId: sid } : {}),
      };
    }),
    includeRaw: parsed.data.includeRaw ?? true,
  };
}

export const createFulfillmentPackageTool = createTool({
  id: 'create-fulfillment-package',
  description:
    'Prepare shipment context in bulk: **TikTok** may **create fulfillment packages** when the order has no packages yet (**id** = order id). **Shopee** does not mirror TikTok create-package; instead it loads **`get_shipping_parameter`** and returns **`details.handover`**: pickup vs drop-off availability, **`needs_handover_choice`**, and **human-readable pickup time slots** when Shopee exposes them—use this tool when the user asks for pickup times or which handover modes exist. Then call **confirm-order-fulfillment** (with **`shopeeHandover`** `pickup` or `dropoff` only if both are offered—e.g. J&T). **Instant** carriers (e.g. SPX Instant) usually expose pickup only: omit **`shopeeHandover`** on confirm. **shopId** = **`shopId`** from **search-orders** when multiple marketplace connections exist. **`includeRaw`**: optional, default **true** in this tool—set **false** to trim large API payloads in **raw**.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345' }],
        includeRaw: false,
      },
    },
    { input: { orders: [{ id: '240501ABC123', platform: 'shopee' }] } },
    {
      input: {
        orders: [{ id: '583865982332471077', platform: 'tiktok', shopId: '7123456789' }],
        includeRaw: false,
      },
    },
  ],
  outputSchema: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        platform: platformEnum,
        success: z.boolean(),
        message: z.string(),
        packageIds: z.array(z.string()).optional(),
        details: z.unknown().optional(),
        raw: z.unknown().optional(),
      }),
    ),
    summary: z.object({
      total: z.number(),
      success: z.number(),
      failed: z.number(),
    }),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseArgs(input);

    const tasks = args.orders.map(async (item): Promise<PrepareShipmentResult> => {
      if (item.platform === 'shopee') {
        const shopeeConns = await listConnectionsByTenant(tenantId, ['shopee']);
        if (shopeeConns.length === 0) {
          return {
            id: item.id,
            platform: 'shopee',
            success: false,
            message: 'No Shopee connection found for tenant.',
          };
        }
        const conns = item.shopId
          ? shopeeConns.filter((c) => c.external_shop_id === item.shopId)
          : shopeeConns;
        if (conns.length === 0) {
          return {
            id: item.id,
            platform: 'shopee',
            success: false,
            message: `No Shopee connection for shop "${item.shopId}" on this tenant.`,
          };
        }
        let last: PrepareShipmentResult | null = null;
        for (const conn of conns) {
          const client = await getShopeeClient(conn.external_shop_id);
          const attempt = await prepareShopeeShipmentContext(client, item.id);
          last = attempt;
          if (attempt.success) return attempt;
        }
        return (
          last ?? {
            id: item.id,
            platform: 'shopee',
            success: false,
            message: item.shopId
              ? `Shopee prepare failed for shop "${item.shopId}".`
              : 'Shopee prepare failed for all connected shops.',
          }
        );
      }

      const tiktokConns = await listConnectionsByTenant(tenantId, ['tiktok']);
      if (tiktokConns.length === 0) {
        return {
          id: item.id,
          platform: 'tiktok',
          success: false,
          message: 'No TikTok connection found for tenant.',
        };
      }
      const conns = item.shopId
        ? (() => {
            const c = findTiktokConnectionForToolShopId(tiktokConns, item.shopId);
            return c ? [c] : [];
          })()
        : tiktokConns;
      if (conns.length === 0) {
        return {
          id: item.id,
          platform: 'tiktok',
          success: false,
          message: `No TikTok connection for shop "${item.shopId}" on this tenant.`,
        };
      }
      let lastTt: PrepareShipmentResult | null = null;
      for (const conn of conns) {
        const ciphers = tiktokCipherPriorityList(conn, item.shopId?.trim() ?? null);
        if (ciphers.length === 0) {
          lastTt = {
            id: item.id,
            platform: 'tiktok',
            success: false,
            message:
              'TikTok connection is missing shop_cipher. Reconnect TikTok and grant authorized-shops scope.',
          };
          continue;
        }
        const client = await getTiktokClient(conn.external_shop_id);
        for (const shopCipher of ciphers) {
          const attempt = await createTiktokFulfillmentPackages(client, item.id, shopCipher);
          lastTt = attempt;
          if (attempt.success) return attempt;
        }
      }
      return (
        lastTt ?? {
          id: item.id,
          platform: 'tiktok',
          success: false,
          message: item.shopId
            ? `TikTok create package failed for shop "${item.shopId}".`
            : 'TikTok create package failed for all connected shops.',
        }
      );
    });

    const settled = await Promise.allSettled(tasks);
    const results: PrepareShipmentResult[] = settled.map((s, index) => {
      if (s.status === 'fulfilled') return s.value;
      const target = args.orders[index];
      return {
        id: target?.id ?? 'unknown',
        platform: target?.platform ?? 'shopee',
        success: false,
        message: s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    });

    const normalized = args.includeRaw
      ? results
      : results.map(({ raw, ...rest }) => rest);
    return {
      results: normalized,
      summary: buildPrepareShipmentSummary(results),
    };
  },
});
