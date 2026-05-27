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
  buildFulfillmentSummary,
  type FulfillmentResult,
  type FulfillmentTarget,
} from '../../integrations/shared/fulfillment';
import { confirmShopeeFulfillment } from '../../integrations/shopee/fulfillment';
import { confirmTiktokFulfillment } from '../../integrations/tiktok/fulfillment';

const platformEnum = z.enum(['shopee', 'tiktok']);

const fulfillmentOrderElementSchema = z
  .object({
    id: z.string().min(1),
    platform: platformEnum,
  })
  .passthrough();

/**
 * LLMs (e.g. Groq function-calling) sometimes send `orders` as a JSON string or a single object
 * instead of an array. Accept those shapes so tool validation does not fail before `execute`.
 */
function normalizeBulkOrdersInput(val: unknown): unknown {
  if (typeof val === 'string') {
    const t = val.trim();
    if (t.length === 0) return val;
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try {
        return normalizeBulkOrdersInput(JSON.parse(t));
      } catch {
        return val;
      }
    }
    return val;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    if (typeof o.id === 'string' && (o.platform === 'shopee' || o.platform === 'tiktok')) {
      return [val];
    }
  }
  return val;
}

/**
 * Public schema: `orders[]` only requires `id` + `platform`.
 * Optional `shopId` per row (passthrough) avoids probing every shop when the tenant has multiple connections.
 */
const confirmFulfillmentInputSchema = z
  .object({
    orders: z.preprocess(
      normalizeBulkOrdersInput,
      z.array(fulfillmentOrderElementSchema).min(1),
    ),
  })
  .passthrough();

const confirmFulfillmentOrderRowSchema = z.object({
  id: z.string().min(1),
  platform: platformEnum,
  shopId: z.string().min(1).nullable().optional(),
  /** Shopee only: `pickup` (jemput) vs `dropoff` (antar counter) when both are offered. */
  shopeeHandover: z.enum(['pickup', 'dropoff']).nullable().optional(),
});

const confirmFulfillmentArgsSchema = z.object({
  orders: z.preprocess(
    normalizeBulkOrdersInput,
    z.array(confirmFulfillmentOrderRowSchema).min(1),
  ),
  includeRaw: z.boolean().nullable().optional(),
});

interface ConfirmFulfillmentArgs {
  orders: FulfillmentTarget[];
  includeRaw: boolean;
}

function parseArgs(input: unknown): ConfirmFulfillmentArgs {
  const parsed = confirmFulfillmentArgsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid confirm-order-fulfillment input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  return {
    orders: parsed.data.orders.map((o) => {
      const sid = o.shopId?.trim();
      const ho = o.shopeeHandover?.trim();
      return {
        id: o.id.trim(),
        platform: o.platform,
        ...(sid ? { shopId: sid } : {}),
        ...(ho === 'pickup' || ho === 'dropoff' ? { shopeeHandover: ho } : {}),
      };
    }),
    includeRaw: parsed.data.includeRaw ?? true,
  };
}

export const confirmOrderFulfillmentTool = createTool({
  id: 'confirm-order-fulfillment',
  description:
    'Confirm ship / fulfill orders in bulk for the tenant. **Input:** `{ orders: [{ id, platform, shopId?, shopeeHandover? }], includeRaw? }`. **`orders`** must be a JSON array (a JSON string that parses to an array is also accepted). **workflow:** for **Shopee**, prefer running **create-fulfillment-package** first to read **`needs_handover_choice`** and pickup slots; then call this tool with **`shopeeHandover`** only when both pickup and drop-off are available. **shopId** = **`shopId`** from **search-orders** when there are multiple Shopee/TikTok connections. **TikTok:** **id** = order id or **package id** from **packageIds** on search/detail; scopes come from the connection. **Shopee:** **id** = order SN. **Instant** channels: omit **`shopeeHandover`**. On success, **`details`** summarizes submitted logistics (including human-readable pickup times). **`includeRaw`**: optional, default **true** here—set **false** to omit heavy **`raw`** in results.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: confirmFulfillmentInputSchema,
  inputExamples: [
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345' }],
        includeRaw: false,
      },
    },
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee' }],
      },
    },
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345', shopeeHandover: 'dropoff' }],
      },
    },
    {
      input: {
        orders: [
          {
            id: '583865982332471077',
            platform: 'tiktok',
            shopId: '7123456789',
          },
        ],
      },
    },
    {
      input: {
        orders: [
          { id: '240501ABC123', platform: 'shopee' },
          { id: '576000000000000001', platform: 'tiktok' },
        ],
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

    const tasks = args.orders.map(async (item): Promise<FulfillmentResult> => {
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
        let last: FulfillmentResult | null = null;
        for (const conn of conns) {
          const client = await getShopeeClient(conn.external_shop_id);
          const attempt = await confirmShopeeFulfillment(client, item.id, {
            shopeeHandover: item.shopeeHandover,
          });
          last = attempt;
          if (attempt.success) return attempt;
        }
        return last ?? {
          id: item.id,
          platform: 'shopee',
          success: false,
          message: item.shopId
            ? `Shopee fulfillment failed for shop "${item.shopId}".`
            : 'Shopee fulfillment failed for all connected shops.',
        };
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
      let lastTt: FulfillmentResult | null = null;
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
          const attempt = await confirmTiktokFulfillment(client, item.id, shopCipher);
          lastTt = attempt;
          if (attempt.success) return attempt;
        }
      }
      return lastTt ?? {
        id: item.id,
        platform: 'tiktok',
        success: false,
        message: item.shopId
          ? `TikTok fulfillment failed for shop "${item.shopId}".`
          : 'TikTok fulfillment failed for all connected shops.',
      };
    });

    const settled = await Promise.allSettled(tasks);
    const results: FulfillmentResult[] = settled.map((s, index) => {
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
      : results.map(({ raw: _raw, ...rest }) => rest);
    return {
      results: normalized,
      summary: buildFulfillmentSummary(results),
    };
  },
});
