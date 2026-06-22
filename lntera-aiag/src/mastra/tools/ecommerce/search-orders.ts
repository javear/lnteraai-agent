import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { buildTiktokSearchSlices } from '../../integrations/shared/tiktok-shop-scope';
import { listConnectionsByTenant } from '../../integrations/shared/supabase';
import { getShopeeClient } from '../../integrations/shopee/client';
import { getTiktokClient } from '../../integrations/tiktok/client';
import {
  clampPageSize,
  splitPageSize,
} from '../../integrations/shared/products';
import {
  decodeOrderCursor,
  encodeOrderCursor,
  normalizedOrderStatusMeaning,
  type NormalizedOrder,
  type OrderCursorState,
  type OrderSearchOptions,
  type PlatformOrderPageResult,
} from '../../integrations/shared/orders';
import { searchShopeeOrders } from '../../integrations/shopee/orders';
import { searchTiktokOrders } from '../../integrations/tiktok/orders';

const platformEnum = z.enum(['both', 'shopee', 'tiktok']);

const orderItemSchema = z.object({
  id: z.string().optional(),
  sku: z.string().optional(),
  name: z.string().optional(),
  quantity: z.number().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
});

const orderSchema = z.object({
  platform: z.enum(['shopee', 'tiktok']),
  shopId: z.string(),
  orderId: z.string(),
  status: z.enum([
    'pending',
    'processing',
    'processed',
    'shipped',
    'delivered',
    'cancelled',
    'completed',
    'unknown',
  ]),
  statusMeaning: z.string(),
  buyerName: z.string().optional(),
  totalAmount: z.number().optional(),
  currency: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  packageIds: z.array(z.string()).optional(),
  items: z.array(orderItemSchema).optional(),
  shippingProvider: z.string().optional(),
  recipientName: z.string().optional(),
  recipientPhone: z.string().optional(),
  addressLine1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  raw: z.unknown().optional(),
});

const perPlatformSchema = z.object({
  shopee: z.object({
    requested: z.boolean(),
    count: z.number().optional(),
    hasMore: z.boolean().optional(),
    error: z.string().optional(),
    skipped: z.string().optional(),
  }).optional(),
  tiktok: z.object({
    requested: z.boolean(),
    count: z.number().optional(),
    hasMore: z.boolean().optional(),
    error: z.string().optional(),
    skipped: z.string().optional(),
  }).optional(),
});

interface PlatformReport {
  requested: boolean;
  count?: number;
  hasMore?: boolean;
  error?: string;
  skipped?: string;
}

/**
 * All keys optional for providers (Groq) that derive JSON Schema `required` from Zod.
 * Use `.partial()` — avoid `.nullable().optional()` here; Groq may treat those as required keys.
 * Nulls are stripped in `widenSearchOrdersInput` before parse.
 */
const searchOrdersParamsSchema = z
  .object({
    platform: platformEnum,
    status: z.string(),
    orderId: z.string(),
    createdFrom: z.number().int().nonnegative(),
    createdTo: z.number().int().nonnegative(),
    /** ISO `YYYY-MM-DD`, unix seconds, or full date string → UTC day range when createdFrom/To omitted. */
    createDate: z.union([z.string(), z.number()]),
    updatedFrom: z.number().int().nonnegative(),
    updatedTo: z.number().int().nonnegative(),
    pageSize: z.number().int().min(1).max(100),
    cursor: z.string(),
    includeRaw: z.boolean(),
    enrichWithDetails: z.boolean(),
  })
  .partial()
  .passthrough();

/** Execute-time validation: known fields + passthrough for forward compatibility. */
const searchOrdersArgsSchema = searchOrdersParamsSchema;

/**
 * Groq strict tool validation treats every listed `properties` key as required.
 * Use a string-keyed map for the provider-facing schema so `{}` and partial args validate; `execute` still validates via `searchOrdersArgsSchema`.
 */
const searchOrdersInputSchema = z.record(z.string(), z.unknown());

type SearchOrdersInputRaw = z.infer<typeof searchOrdersParamsSchema>;

interface SearchOrdersArgs {
  platform: z.infer<typeof platformEnum>;
  status?: string;
  orderId?: string;
  createdFrom?: number;
  createdTo?: number;
  updatedFrom?: number;
  updatedTo?: number;
  pageSize?: number;
  cursor?: string;
  includeRaw: boolean;
  enrichWithDetails: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function widenSearchOrdersInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) {
      delete base[k];
    }
  }
  if (base.orderId == null && typeof base.order_id === 'string') {
    base.orderId = base.order_id;
  }
  return base;
}

function parseCreateDateToRange(v: string | number): { from?: number; to?: number } {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const sec = v < 1e12 ? Math.floor(v) : Math.floor(v / 1000);
    const start = new Date(sec * 1000);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(sec * 1000);
    end.setUTCHours(23, 59, 59, 999);
    return { from: Math.floor(start.getTime() / 1000), to: Math.floor(end.getTime() / 1000) };
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
    return { from: Math.floor(start / 1000), to: Math.floor(end / 1000) };
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const start = new Date(t);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(t);
    end.setUTCHours(23, 59, 59, 999);
    return { from: Math.floor(start.getTime() / 1000), to: Math.floor(end.getTime() / 1000) };
  }
  return {};
}

function resolveSearchOrdersArgs(raw: SearchOrdersInputRaw): SearchOrdersArgs {
  const trimOrUndef = (s: string | null | undefined) => {
    if (s == null) return undefined;
    const t = s.trim();
    return t === '' ? undefined : t;
  };

  let createdFrom = raw.createdFrom ?? undefined;
  let createdTo = raw.createdTo ?? undefined;
  if (createdFrom == null && createdTo == null && raw.createDate != null && raw.createDate !== '') {
    const span = parseCreateDateToRange(raw.createDate);
    createdFrom = span.from;
    createdTo = span.to;
  }

  return {
    platform: raw.platform ?? 'both',
    status: trimOrUndef(raw.status),
    orderId: trimOrUndef(raw.orderId),
    createdFrom,
    createdTo,
    updatedFrom: raw.updatedFrom ?? undefined,
    updatedTo: raw.updatedTo ?? undefined,
    pageSize: raw.pageSize ?? undefined,
    cursor: trimOrUndef(raw.cursor),
    includeRaw: raw.includeRaw === true,
    // Default OFF: lean rows (id/status/buyer/total/dates) keep the tool result small so it doesn't
    // blow the model's token budget when stored in memory + re-sent each turn. Enriching every row
    // replaces it with the full detail object (items/recipient/phone/address) AND fires a detail API
    // call per row. The model opts in (enrichWithDetails: true) only when it needs those fields.
    enrichWithDetails: raw.enrichWithDetails ?? false,
  };
}

function parseSearchOrdersArgs(input: unknown): SearchOrdersArgs {
  const parsed = searchOrdersArgsSchema.safeParse(widenSearchOrdersInput(input));
  if (!parsed.success) {
    throw new Error(`Invalid search-orders input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return resolveSearchOrdersArgs(parsed.data);
}

export const searchOrdersTool = createTool({
  id: 'search-orders',
  /** Groq: strict tool input forces all schema properties to be sent; disable for optional filters. */
  strict: false,
  description:
    'Search orders for the tenant. Rows are LEAN by default: orderId, shopId, platform, status, statusMeaning, buyerName, totalAmount, currency, dates — enough to list/summarize orders. For items / recipient / address, set enrichWithDetails: true (default false — heavier, fires a detail call per row) or call get-order-details for the one order the user asked about. Optional: platform, status, orderId, dates, pageSize, cursor, includeRaw, enrichWithDetails. Pass shopId from rows into detail/fulfillment/label tools when multiple shops exist.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: searchOrdersInputSchema,
  inputExamples: [
    { input: {} },
    {
      input: {
        platform: 'shopee',
        status: 'processing',
        pageSize: 20,
      },
    },
    { input: { platform: 'tiktok', status: 'AWAITING_SHIPMENT', pageSize: 20 } },
    { input: { platform: 'shopee', orderId: '240101ABC123', includeRaw: true } },
    { input: { platform: 'shopee', enrichWithDetails: true, pageSize: 10 } },
  ],
  outputSchema: z.object({
    orders: z.array(orderSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    perPlatform: perPlatformSchema,
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseSearchOrdersArgs(input);

    const platform = args.platform;
    const targets: Array<'shopee' | 'tiktok'> =
      platform === 'both' ? ['shopee', 'tiktok'] : [platform];

    const totalPageSize = clampPageSize(args.pageSize, 20, 100);
    const sliceSizes = splitPageSize(totalPageSize, targets.length);
    const cursor: OrderCursorState = decodeOrderCursor(args.cursor);

    const baseOpts: OrderSearchOptions = {
      status: args.status,
      orderId: args.orderId,
      createdFrom: args.createdFrom,
      createdTo: args.createdTo,
      updatedFrom: args.updatedFrom,
      updatedTo: args.updatedTo,
      includeRaw: args.includeRaw,
      enrichWithDetails: args.enrichWithDetails,
      pageSize: 1,
    };

    const perPlatform: { shopee?: PlatformReport; tiktok?: PlatformReport } = {};
    const orders: NormalizedOrder[] = [];
    const nextCursor: OrderCursorState = {};
    const explicitSingle = platform !== 'both';

    const tasks = targets.map((p, idx) => async () => {
      const slicePageSize = sliceSizes[idx] ?? totalPageSize;
      const opts: OrderSearchOptions = { ...baseOpts, pageSize: slicePageSize };

      try {
        let result: PlatformOrderPageResult | null = null;

        if (p === 'shopee') {
          const shopeeConns = await listConnectionsByTenant(tenantId, ['shopee']);
          if (shopeeConns.length === 0) {
            result = null;
          } else {
            const legacySingleCursor =
              cursor.shopee?.cursor && !cursor.shopee?.byShop ? cursor.shopee.cursor : undefined;
            const byShopIn = cursor.shopee?.byShop ?? {};
            const perShopPageSize =
              shopeeConns.length === 1
                ? slicePageSize
                : Math.max(1, Math.floor(slicePageSize / shopeeConns.length));

            const mergedOrders: NormalizedOrder[] = [];
            let combinedHasMore = false;
            const nextByShop: Record<string, string> = {};

            for (let i = 0; i < shopeeConns.length; i++) {
              const conn = shopeeConns[i];
              const shopKey = conn.external_shop_id;
              let shopCursor = byShopIn[shopKey];
              if (shopCursor === undefined && legacySingleCursor !== undefined && i === 0) {
                shopCursor = legacySingleCursor;
              }

              const client = await getShopeeClient(conn.external_shop_id);
              const page = await searchShopeeOrders(client, {
                ...opts,
                pageSize: perShopPageSize,
                cursor: shopCursor,
              });
              mergedOrders.push(...page.orders);
              if (page.hasMore && page.nextShopeeCursor) {
                combinedHasMore = true;
                nextByShop[shopKey] = page.nextShopeeCursor;
              }
            }

            let nextShopeeCursor: string | undefined;
            if (shopeeConns.length === 1 && nextByShop[shopeeConns[0].external_shop_id]) {
              nextShopeeCursor = nextByShop[shopeeConns[0].external_shop_id];
            }

            result = {
              orders: mergedOrders,
              hasMore: combinedHasMore,
              nextShopeeCursor,
              nextShopeeByShop: Object.keys(nextByShop).length ? nextByShop : undefined,
            };
          }
        } else {
          const tiktokConns = await listConnectionsByTenant(tenantId, ['tiktok']);
          if (tiktokConns.length === 0) {
            result = null;
          } else {
            const slices = buildTiktokSearchSlices(tiktokConns);
            const legacyToken =
              cursor.tiktok?.pageToken && !cursor.tiktok?.byShop ? cursor.tiktok.pageToken : undefined;
            const byShopIn = cursor.tiktok?.byShop ?? {};
            const perShopPageSize = Math.max(1, Math.floor(slicePageSize / Math.max(1, slices.length)));

            const mergedOrders: NormalizedOrder[] = [];
            let combinedHasMore = false;
            const nextByShop: Record<string, string> = {};

            let legacyConsumed = false;
            for (let i = 0; i < slices.length; i++) {
              const { conn, cursorKey, cipher, useLegacyOpenIdCursor } = slices[i];
              let pageToken = byShopIn[cursorKey];
              if (pageToken === undefined && useLegacyOpenIdCursor) {
                pageToken = byShopIn[conn.external_shop_id];
              }
              if (pageToken === undefined && legacyToken !== undefined && !legacyConsumed) {
                pageToken = legacyToken;
                legacyConsumed = true;
              }

              const client = await getTiktokClient(conn.external_shop_id);
              const page = await searchTiktokOrders(client, {
                ...opts,
                pageSize: perShopPageSize,
                pageToken,
                shopCipher: cipher,
              });
              mergedOrders.push(...page.orders);
              if (page.hasMore && page.nextTiktokPageToken) {
                combinedHasMore = true;
                nextByShop[cursorKey] = page.nextTiktokPageToken;
              }
            }

            let nextTiktokPageToken: string | undefined;
            if (slices.length === 1 && nextByShop[slices[0].cursorKey]) {
              nextTiktokPageToken = nextByShop[slices[0].cursorKey];
            }

            result = {
              orders: mergedOrders,
              hasMore: combinedHasMore,
              nextTiktokPageToken,
              nextTiktokByShop: Object.keys(nextByShop).length ? nextByShop : undefined,
            };
          }
        }

        if (!result) {
          const message = `No ${p} connection found for tenant.`;
          if (explicitSingle) throw new Error(message);
          perPlatform[p] = { requested: true, skipped: message };
          return;
        }

        orders.push(...result.orders);
        perPlatform[p] = {
          requested: true,
          count: result.orders.length,
          hasMore: result.hasMore,
        };

        if (result.hasMore) {
          if (p === 'shopee') {
            const byShop = result.nextShopeeByShop;
            if (byShop && Object.keys(byShop).length > 0) {
              nextCursor.shopee = { byShop };
            } else if (result.nextShopeeCursor) {
              nextCursor.shopee = { cursor: result.nextShopeeCursor };
            }
          }
          if (p === 'tiktok') {
            const byShopTt = result.nextTiktokByShop;
            if (byShopTt && Object.keys(byShopTt).length > 0) {
              nextCursor.tiktok = { byShop: byShopTt };
            } else if (result.nextTiktokPageToken) {
              nextCursor.tiktok = { pageToken: result.nextTiktokPageToken };
            }
          }
        }
      } catch (err) {
        const message = describeError(err);
        if (explicitSingle) throw err;
        perPlatform[p] = { requested: true, error: message };
      }
    });

    await Promise.all(tasks.map((run) => run()));

    const encoded = encodeOrderCursor(nextCursor);
    return {
      orders: orders.map((o) => ({
        ...o,
        statusMeaning: normalizedOrderStatusMeaning(o.status),
      })),
      nextCursor: encoded,
      hasMore: Boolean(encoded),
      perPlatform,
    };
  },
});
