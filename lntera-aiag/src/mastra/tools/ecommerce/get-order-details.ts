import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  findTiktokConnectionForToolShopId,
  listTiktokShopCiphers,
  requireTenantContext,
  tiktokCipherPriorityList,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import {
  buildOrderDetailSummary,
  normalizedOrderStatusMeaning,
  type NormalizedOrderDetail,
  type OrderDetailResult,
  type OrderDetailTarget,
  type OrderPlatform,
} from '../../integrations/shared/orders';
import { getShopeeOrderDetails } from '../../integrations/shopee/orders';
import { redactShopCipher, ttOrderDetailDebug } from '../../integrations/tiktok/order-detail-debug';
import { resolveTiktokOrderDetailsByShop } from '../../integrations/tiktok/order-detail';

const platformEnum = z.enum(['shopee', 'tiktok']);

/**
 * Groq: prefer empty object + passthrough (see search-products) over z.record — some stacks reject record JSON Schema.
 * search-orders also sets `strict: false` on the tool so the API accepts partial tool arguments.
 * Execute still validates with `getOrderDetailsArgsSchema` after `widenGetOrderDetailsInput`.
 */
const getOrderDetailsInputSchema = z
  .object({})
  .passthrough()
  .describe('Object with orders (array) and optional includeRaw (default false — set true for marketplace raw payloads). Other keys ignored until widened.');

export const getOrderDetailsArgsSchema = z.object({
  // Capped at 20 — with includeRaw:true, each order can carry a full marketplace API JSON payload;
  // an uncapped batch here was found able to alone exceed general-agent's entire ~7k-token turn
  // budget in one tool result (the same class of bug fixed for Forge's studio-read-file/git-diff:
  // see truncateForAgent in src/mastra/integrations/studio/tools.ts). 20 specific orders by id is
  // already generous for what's normally a "look up this one order" or small-batch use case.
  orders: z
    .array(
      z.discriminatedUnion('platform', [
        z.object({
          id: z.string().min(1),
          platform: z.literal('shopee'),
          /** When omitted, tenant’s Shopee connection(s) are tried (works with a single shop). */
          shopId: z.string().min(1).optional(),
        }),
        z.object({
          id: z.string().min(1),
          platform: z.literal('tiktok'),
          /** When omitted, all connected TikTok shops are tried (slower; prefer search-orders `shopId` for multi-shop). */
          shopId: z.string().min(1).optional(),
        }),
      ]),
    )
    .min(1)
    .max(20),
  includeRaw: z.boolean().nullable().optional(),
});

interface GetOrderDetailsArgs {
  orders: OrderDetailTarget[];
  includeRaw: boolean;
}

/**
 * TikTok (and other) snowflake ids exceed `Number.MAX_SAFE_INTEGER`; JSON numbers round,
 * so `"id": 583867341493471013` becomes the wrong id and lookups return empty.
 * Search-orders is unaffected (TikTok responses use json-bigint as strings).
 * Reject unsafe numbers even when `platform` is omitted (array-shaped tool args).
 */
function assertOrderIdNotUnsafeJsonNumber(rawId: unknown, ctx: string): void {
  if (typeof rawId === 'number' && Number.isFinite(rawId) && !Number.isSafeInteger(rawId)) {
    throw new Error(
      `${ctx}: order id must be a JSON string, not a number — this value exceeds JavaScript's safe integer range and is rounded. ` +
        `For TikTok, copy orderId from search-orders with quotes (e.g. "583867341493471013").`,
    );
  }
}

function coerceOrderDetailInputRow(row: unknown): unknown {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return row;
  const o = { ...(row as Record<string, unknown>) };
  assertOrderIdNotUnsafeJsonNumber(o.id, 'get-order-details');
  assertOrderIdNotUnsafeJsonNumber(o.orderId, 'get-order-details');
  const id =
    typeof o.id === 'string'
      ? o.id.trim()
      : typeof o.id === 'number' && Number.isFinite(o.id)
        ? String(o.id)
        : typeof o.orderId === 'string'
          ? o.orderId.trim()
          : typeof o.orderId === 'number' && Number.isFinite(o.orderId)
            ? String(o.orderId)
            : '';
  if (id) o.id = id;
  const shopId =
    typeof o.shopId === 'string'
      ? o.shopId.trim()
      : typeof o.shopId === 'number' && Number.isFinite(o.shopId)
        ? String(o.shopId)
        : '';
  if (shopId) o.shopId = shopId;
  return o;
}

/**
 * Models often omit `orders` or send one order at the top level / as `order`. Shape for execute is always `{ orders: [...] }`.
 */
function widenGetOrderDetailsInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) {
    return {};
  }
  if (Array.isArray(input)) {
    return { orders: input };
  }
  if (typeof input !== 'object') {
    return {};
  }
  const r = { ...(input as Record<string, unknown>) };
  let orders = r.orders;

  if (orders === undefined && r.order != null && typeof r.order === 'object' && !Array.isArray(r.order)) {
    orders = [r.order];
  }

  if (orders === undefined) {
    const idRaw = r.id ?? r.orderId;
    const platform = r.platform;
    assertOrderIdNotUnsafeJsonNumber(idRaw, 'get-order-details');
    const id =
      typeof idRaw === 'string' ? idRaw.trim() : typeof idRaw === 'number' && Number.isFinite(idRaw) ? String(idRaw) : '';
    const shopRaw = r.shopId;
    const shopStr =
      typeof shopRaw === 'string'
        ? shopRaw.trim()
        : typeof shopRaw === 'number' && Number.isFinite(shopRaw)
          ? String(shopRaw)
          : '';
    if (id && (platform === 'shopee' || platform === 'tiktok')) {
      orders = shopStr !== '' ? [{ id, platform, shopId: shopStr }] : [{ id, platform }];
    }
  }

  if (orders != null && !Array.isArray(orders) && typeof orders === 'object') {
    orders = [orders];
  }

  if (Array.isArray(orders)) {
    orders = orders.map((row) => coerceOrderDetailInputRow(row));
  }

  if (orders !== undefined) {
    r.orders = orders;
  }
  return r;
}

function parseArgs(input: unknown): GetOrderDetailsArgs {
  const widened = widenGetOrderDetailsInput(input);
  const parsed = getOrderDetailsArgsSchema.safeParse(widened);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(
      `Invalid get-order-details input: ${detail}. Expected { orders: [{ id, platform, shopId? }], includeRaw? } — shopId optional (omitted = try all tenant connections for that platform); includeRaw optional (default false: no raw payloads). Or top-level id + platform + optional shopId.`,
    );
  }
  return {
    orders: parsed.data.orders.map((o) => {
      const sid = o.shopId?.trim();
      if (o.platform === 'shopee') {
        return sid
          ? { id: o.id.trim(), platform: 'shopee' as const, shopId: sid }
          : { id: o.id.trim(), platform: 'shopee' as const };
      }
      return sid
        ? { id: o.id.trim(), platform: 'tiktok' as const, shopId: sid }
        : { id: o.id.trim(), platform: 'tiktok' as const };
    }),
    includeRaw: parsed.data.includeRaw === true,
  };
}

function collectOrderIdsByShop(
  orders: OrderDetailTarget[],
  platform: OrderPlatform,
): { byShop: Map<string, string[]>; implicit: string[] } {
  const byShop = new Map<string, string[]>();
  const implicit: string[] = [];
  const seenImplicit = new Set<string>();
  for (const o of orders) {
    if (o.platform !== platform) continue;
    if (o.shopId) {
      const cur = byShop.get(o.shopId) ?? [];
      if (!cur.includes(o.id)) cur.push(o.id);
      byShop.set(o.shopId, cur);
    } else if (!seenImplicit.has(o.id)) {
      seenImplicit.add(o.id);
      implicit.push(o.id);
    }
  }
  return { byShop, implicit };
}

export const getOrderDetailsTool = createTool({
  id: 'get-order-details',
  strict: false,
  description:
    'Order details for connected shops. Input: orders[{ id, platform, shopId? }] or top-level id/platform/shopId. Shopee id=order SN; TikTok id=order id (string). Pass shopId from search-orders when multiple shops. includeRaw default false.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: getOrderDetailsInputSchema,
  inputExamples: [
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345' }],
      },
    },
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee' }],
      },
    },
    {
      input: {
        orders: [{ id: '576000000000000001', platform: 'tiktok', shopId: '7123456789' }],
        includeRaw: false,
      },
    },
    {
      input: {
        id: '240501ABC123',
        platform: 'shopee',
        shopId: '12345',
      },
    },
    {
      input: {
        orders: [{ id: '240501ABC123', platform: 'shopee', shopId: '12345' }],
        includeRaw: true,
      },
    },
    {
      input: {
        orders: [
          { id: '240501ABC123', platform: 'shopee', shopId: '12345' },
          { id: '576000000000000001', platform: 'tiktok', shopId: '7123456789' },
        ],
      },
    },
  ],
  /** Groq: keep output loose — nested z.unknown can break some function-calling stacks. */
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseArgs(input);

    const shopeeMap = new Map<string, NormalizedOrderDetail>();
    const tiktokMap = new Map<string, NormalizedOrderDetail>();
    let shopeeImplicitError: string | undefined;
    let tiktokImplicitError: string | undefined;
    const shopeeMissingShop = new Set<string>();
    const tiktokMissingShop = new Set<string>();
    const shopeeShopFetchError = new Map<string, string>();
    const tiktokShopFetchError = new Map<string, string>();

    const { byShop: shopeeByShop, implicit: shopeeImplicit } = collectOrderIdsByShop(
      args.orders,
      'shopee',
    );
    const { byShop: tiktokByShop, implicit: tiktokImplicit } = collectOrderIdsByShop(args.orders, 'tiktok');

    await Promise.allSettled([
      (async () => {
        const hasWork = shopeeByShop.size > 0 || shopeeImplicit.length > 0;
        if (!hasWork) return;
        const shopeeConns = await listConnectionsByTenant(tenantId, ['shopee']);
        if (shopeeConns.length === 0) {
          shopeeImplicitError = 'No Shopee connection found for tenant.';
          for (const shopId of shopeeByShop.keys()) shopeeMissingShop.add(shopId);
          return;
        }
        const shopeeErrors: string[] = [];

        for (const [shopId, ids] of shopeeByShop.entries()) {
          const conn = shopeeConns.find((c) => c.external_shop_id === shopId);
          if (!conn) {
            shopeeMissingShop.add(shopId);
            continue;
          }
          try {
            const client = await getShopeeClient(conn.external_shop_id);
            const details = await getShopeeOrderDetails(client, ids, args.includeRaw);
            for (const [id, order] of details.entries()) {
              if (!shopeeMap.has(id)) shopeeMap.set(id, order);
            }
          } catch (e) {
            shopeeShopFetchError.set(shopId, e instanceof Error ? e.message : String(e));
          }
        }

        if (shopeeImplicit.length > 0) {
          for (const conn of shopeeConns) {
            try {
              const client = await getShopeeClient(conn.external_shop_id);
              const details = await getShopeeOrderDetails(client, shopeeImplicit, args.includeRaw);
              for (const [id, order] of details.entries()) {
                if (!shopeeMap.has(id)) shopeeMap.set(id, order);
              }
            } catch (e) {
              shopeeErrors.push(e instanceof Error ? e.message : String(e));
            }
          }
          const missingShopee = shopeeImplicit.filter((id) => !shopeeMap.has(id));
          if (missingShopee.length > 0 && shopeeConns.length > 0) {
            shopeeImplicitError =
              shopeeErrors.length > 0
                ? `Not found in any connected Shopee shop (tried ${shopeeConns.length}). ${shopeeErrors[shopeeErrors.length - 1]}`
                : `Order not found in any connected Shopee shop.`;
          }
        }
      })(),
      (async () => {
        const hasWork = tiktokByShop.size > 0 || tiktokImplicit.length > 0;
        if (!hasWork) return;
        const tiktokConns = await listConnectionsByTenant(tenantId, ['tiktok']);
        if (tiktokConns.length === 0) {
          tiktokImplicitError = 'No TikTok connection found for tenant.';
          for (const shopId of tiktokByShop.keys()) tiktokMissingShop.add(shopId);
          return;
        }
        let anyCipherForImplicit = false;
        const tiktokErrors: string[] = [];

        for (const [shopId, ids] of tiktokByShop.entries()) {
          const conn = findTiktokConnectionForToolShopId(tiktokConns, shopId);
          if (!conn) {
            ttOrderDetailDebug('get-order-details: no TikTok connection matched tool shopId', {
              toolShopIdFromRow: shopId,
              connectionCount: tiktokConns.length,
              connectionExternalShopIds: tiktokConns.map((c) => c.external_shop_id),
            });
            tiktokMissingShop.add(shopId);
            continue;
          }
          const ciphers = listTiktokShopCiphers(conn);
          if (ciphers.length === 0) {
            tiktokShopFetchError.set(
              shopId,
              `TikTok shop ${shopId} is missing shop_cipher; reconnect TikTok with authorized shops scope.`,
            );
            continue;
          }
          const cipherPriority = tiktokCipherPriorityList(conn, shopId);
          ttOrderDetailDebug('get-order-details: tiktok batch (tool execution)', {
            toolShopIdFromRow: shopId,
            connectionExternalShopId: conn.external_shop_id,
            orderIdsRequested: ids,
            cipherCountFromConnection: ciphers.length,
            cipherPriorityFingerprints: cipherPriority.map((c) => redactShopCipher(c)),
          });
          try {
            const client = await getTiktokClient(conn.external_shop_id);
            const details = await resolveTiktokOrderDetailsByShop(client, ids, args.includeRaw, {
              shopCiphers: cipherPriority,
            });
            ttOrderDetailDebug('get-order-details: tiktok batch merged into map', {
              toolShopIdFromRow: shopId,
              orderIdsRequested: ids,
              resolvedOrderIds: [...details.keys()],
            });
            for (const [id, order] of details.entries()) {
              if (!tiktokMap.has(id)) tiktokMap.set(id, order);
            }
          } catch (e) {
            tiktokShopFetchError.set(shopId, e instanceof Error ? e.message : String(e));
          }
        }

        if (tiktokImplicit.length > 0) {
          let remainingImplicit = tiktokImplicit.filter((id) => !tiktokMap.has(id));
          for (const conn of tiktokConns) {
            if (remainingImplicit.length === 0) break;
            const ciphers = listTiktokShopCiphers(conn);
            if (ciphers.length === 0) {
              tiktokErrors.push(`TikTok shop ${conn.external_shop_id}: missing shop_cipher`);
              continue;
            }
            anyCipherForImplicit = true;
            try {
              const client = await getTiktokClient(conn.external_shop_id);
              const details = await resolveTiktokOrderDetailsByShop(
                client,
                remainingImplicit,
                args.includeRaw,
                {
                  shopCiphers: tiktokCipherPriorityList(conn, conn.external_shop_id),
                },
              );
              for (const [id, order] of details.entries()) {
                if (!tiktokMap.has(id)) tiktokMap.set(id, order);
              }
            } catch (e) {
              tiktokErrors.push(e instanceof Error ? e.message : String(e));
            }
            remainingImplicit = tiktokImplicit.filter((id) => !tiktokMap.has(id));
          }
          const missingTt = tiktokImplicit.filter((id) => !tiktokMap.has(id));
          if (missingTt.length > 0) {
            if (!anyCipherForImplicit) {
              tiktokImplicitError =
                'TikTok connection(s) are missing shop_cipher. Reconnect TikTok and ensure authorized shops scope is granted.';
            } else if (tiktokErrors.length > 0) {
              tiktokImplicitError = `Not found in any connected TikTok shop (tried ${tiktokConns.length}). ${tiktokErrors[tiktokErrors.length - 1]}`;
            } else {
              tiktokImplicitError = `Order not found in any connected TikTok shop (tried ${tiktokConns.length}). Pass shopId from each search-orders row (per-shop for TikTok).`;
            }
          }
        }
      })(),
    ]).then((settled) => {
      const shopee = settled[0];
      const tiktok = settled[1];
      if (shopee.status === 'rejected') {
        shopeeImplicitError =
          shopee.reason instanceof Error ? shopee.reason.message : String(shopee.reason);
      }
      if (tiktok.status === 'rejected') {
        tiktokImplicitError =
          tiktok.reason instanceof Error ? tiktok.reason.message : String(tiktok.reason);
      }
    });

    const results: OrderDetailResult[] = args.orders.map((target) => {
      const sourceMap = target.platform === 'shopee' ? shopeeMap : tiktokMap;
      const order = sourceMap.get(target.id);
      if (order) {
        return {
          id: target.id,
          platform: target.platform,
          success: true,
          order,
          raw: args.includeRaw ? order.raw : undefined,
        };
      }

      if (target.shopId) {
        const missing = target.platform === 'shopee' ? shopeeMissingShop : tiktokMissingShop;
        const fetchErr = target.platform === 'shopee' ? shopeeShopFetchError : tiktokShopFetchError;
        if (missing.has(target.shopId)) {
          return {
            id: target.id,
            platform: target.platform,
            success: false,
            message: `No ${target.platform} connection for shop "${target.shopId}" on this tenant.`,
          };
        }
        const fe = fetchErr.get(target.shopId);
        if (fe) {
          return {
            id: target.id,
            platform: target.platform,
            success: false,
            message: fe,
          };
        }
        return {
          id: target.id,
          platform: target.platform,
          success: false,
          message: `Order not found on ${target.platform} shop "${target.shopId}".`,
        };
      }

      const platformError = target.platform === 'shopee' ? shopeeImplicitError : tiktokImplicitError;
      return {
        id: target.id,
        platform: target.platform,
        success: false,
        message: platformError ?? `Order not found for ${target.platform}.`,
      };
    });

    const resultsWithStatusMeaning: OrderDetailResult[] = results.map((r) => {
      if (!r.success || !r.order) return r;
      const o = r.order;
      const orderBody = args.includeRaw
        ? { ...o, statusMeaning: normalizedOrderStatusMeaning(o.status) }
        : (() => {
            const { raw: _omit, ...rest } = o;
            return { ...rest, statusMeaning: normalizedOrderStatusMeaning(o.status) };
          })();
      return {
        ...r,
        order: orderBody,
        ...(args.includeRaw ? {} : { raw: undefined }),
      };
    });

    return {
      results: resultsWithStatusMeaning,
      summary: buildOrderDetailSummary(results),
    };
  },
});
