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
import type { FulfillmentTarget } from '../../integrations/shared/fulfillment';
import { buildShippingLabelSummary, type ShippingLabelResult } from '../../integrations/shared/shipping-labels';
import { fetchShopeeShippingLabelsForOrder } from '../../integrations/shopee/shipping-document';
import { fetchTiktokShippingLabels } from '../../integrations/tiktok/shipping-document';

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

const tiktokShippingDocumentSizeEnum = z.enum(['A5', 'A6']);

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
  embedDocument: z.boolean().nullable().optional(),
  tiktokDocumentType: z.string().min(1).nullable().optional(),
  /** TikTok Fulfillment API requires `A5` or `A6` (default applied in integration when omitted). */
  tiktokDocumentSize: tiktokShippingDocumentSizeEnum.nullable().optional(),
});

interface Args {
  orders: FulfillmentTarget[];
  includeRaw: boolean;
  embedDocument: boolean;
  tiktokDocumentType?: string;
  tiktokDocumentSize?: 'A5' | 'A6';
}

function parseArgs(input: unknown): Args {
  const parsed = argsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid get-shipping-labels input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const dt = parsed.data.tiktokDocumentType?.trim();

  return {
    orders: parsed.data.orders.map((o) => {
      const sid = o.shopId?.trim();
      return {
        id: o.id.trim(),
        platform: o.platform,
        ...(sid ? { shopId: sid } : {}),
      };
    }),
    includeRaw: parsed.data.includeRaw ?? false,
    embedDocument: parsed.data.embedDocument === true,
    ...(dt ? { tiktokDocumentType: dt } : {}),
    ...(parsed.data.tiktokDocumentSize != null ? { tiktokDocumentSize: parsed.data.tiktokDocumentSize } : {}),
  };
}

export const getShippingLabelsTool = createTool({
  id: 'get-shipping-labels',
  description:
    'Get/print bulk shipping labels (AWB / tracking number / waybill). Input: orders[{ id, platform, shopId? }]. Pass shopId from search-orders when multiple shops. Shopee: order SN, logistics-ready. TikTok: order or package id; tiktokDocumentSize A5|A6 (default A6). includeRaw default false.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345' }],
      },
    },
    { input: { orders: [{ id: '240501ABC123', platform: 'shopee' }] } },
    {
      input: {
        orders: [{ id: '583865982332471077', platform: 'tiktok', shopId: '7123456789' }],
        embedDocument: true,
        tiktokDocumentSize: 'A5',
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
        packageRefs: z.array(z.string()).optional(),
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

    const tasks = args.orders.map(async (item): Promise<ShippingLabelResult> => {
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
        let last: ShippingLabelResult | null = null;
        const triedShops: string[] = [];
        for (const conn of conns) {
          triedShops.push(conn.external_shop_id);
          const client = await getShopeeClient(conn.external_shop_id);
          const attempt = await fetchShopeeShippingLabelsForOrder(client, item.id, {
            embedDocument: args.embedDocument,
            includeRaw: args.includeRaw,
          });
          last = attempt;
          if (attempt.success) return attempt;
        }
        const baseMsg = last?.message ?? 'Shopee label fetch failed.';
        const notFound = /error_not_found|order is not found/i.test(baseMsg);
        if (notFound) {
          const shopHint =
            triedShops.length > 1
              ? ` Tried ${triedShops.length} Shopee shops (${triedShops.join(', ')}). Pass **shopId** exactly as on the **search-orders** row (\`shopId\` = connection external_shop_id) so the correct shop is used.`
              : ` Connected shop id: ${triedShops[0] ?? 'unknown'}. Confirm the order SN in Seller Centre and that this tenant’s Shopee connection owns the order; if you use several Shopee shops, pass **shopId** from search-orders.`;
          return {
            id: item.id,
            platform: 'shopee',
            success: false,
            message: `${baseMsg.replace(/\.$/, '')}.${shopHint}`,
            ...(last?.details ? { details: last.details } : {}),
            ...(last?.raw && args.includeRaw ? { raw: last.raw } : {}),
            ...(last?.packageRefs ? { packageRefs: last.packageRefs } : {}),
          };
        }
        return last ?? {
          id: item.id,
          platform: 'shopee',
          success: false,
          message: item.shopId
            ? `Shopee label fetch failed for shop "${item.shopId}".`
            : 'Shopee label fetch failed for all connected shops.',
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
      let lastTt: ShippingLabelResult | null = null;
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
          const attempt = await fetchTiktokShippingLabels(client, item.id, shopCipher, {
            documentType: args.tiktokDocumentType,
            documentSize: args.tiktokDocumentSize,
            embedDocument: args.embedDocument,
            includeRaw: args.includeRaw,
          });
          lastTt = attempt;
          if (attempt.success) return attempt;
        }
      }
      return lastTt ?? {
        id: item.id,
        platform: 'tiktok',
        success: false,
        message: item.shopId
          ? `TikTok label fetch failed for shop "${item.shopId}".`
          : 'TikTok label fetch failed for all connected shops.',
      };
    });

    const settled = await Promise.allSettled(tasks);
    const results: ShippingLabelResult[] = settled.map((s, index) => {
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
      summary: buildShippingLabelSummary(results),
    };
  },
});
