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
  decodeCursor,
  encodeCursor,
  splitPageSize,
  type CursorState,
  type NormalizedProduct,
  type PlatformPageResult,
  type SearchOptions,
} from '../../integrations/shared/products';
import { searchShopeeProducts } from '../../integrations/shopee/products';
import { searchTiktokProducts } from '../../integrations/tiktok/products';

const platformEnum = z.enum(['both', 'shopee', 'tiktok']);
const sortEnum = z.enum(['relevance', 'sales', 'price_asc', 'price_desc']);
const statusEnum = z.enum(['active', 'inactive']);

const productSkuLineSchema = z.object({
  id: z.string().optional(),
  sellerSku: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  quantity: z.number().optional(),
});

const productSchema = z.object({
  platform: z.enum(['shopee', 'tiktok']),
  shopId: z.string(),
  productId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'unknown']),
  price: z.number().optional(),
  currency: z.string().optional(),
  imageUrl: z.string().optional(),
  url: z.string().optional(),
  rating: z.object({ average: z.number(), count: z.number() }).optional(),
  soldCount: z.number().optional(),
  totalAvailableStock: z.number().optional(),
  skus: z.array(productSkuLineSchema).optional(),
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * All keys optional for providers (Groq) that derive JSON Schema `required` from Zod.
 * Use `.partial()` — avoid `.nullable().optional()` here; Groq may treat those as required keys.
 */
const searchProductsParamsSchema = z
  .object({
    platform: platformEnum,
    keyword: z.string(),
    /** Common LLM alias for keyword */
    q: z.string(),
    status: statusEnum,
    priceMin: z.number().nonnegative(),
    priceMax: z.number().nonnegative(),
    sort: sortEnum,
    pageSize: z.number().int().min(1).max(100),
    cursor: z.string(),
    /** Full platform payloads; default off to keep LLM context small */
    includeRaw: z.boolean(),
  })
  .partial()
  .passthrough();

/** Execute-time validation: known fields + passthrough for forward compatibility. */
const searchProductsArgsSchema = searchProductsParamsSchema;

/**
 * Groq strict tool validation treats every listed `properties` key as required.
 * Use a string-keyed map for the provider-facing schema so `{}` and partial args validate;
 * `execute` still validates via `searchProductsArgsSchema`.
 */
const searchProductsInputSchema = z.record(z.string(), z.unknown());

type SearchProductsInputRaw = z.infer<typeof searchProductsParamsSchema>;

/** Normalized args after defaults; keeps execute logic simple. */
interface SearchProductsArgs {
  platform: z.infer<typeof platformEnum>;
  keyword?: string;
  status: z.infer<typeof statusEnum>;
  priceMin?: number;
  priceMax?: number;
  sort: z.infer<typeof sortEnum>;
  pageSize?: number;
  cursor?: string;
  /** Explicit true only — full `raw` + untrimmed description */
  includeRaw: boolean;
}

function widenSearchProductsInput(input: unknown): Record<string, unknown> {
  const base =
    input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of Object.keys(base)) {
    if (base[k] === null) delete base[k];
  }
  if (base.keyword == null && typeof base.q === 'string' && base.q.trim()) {
    base.keyword = base.q.trim();
  }
  return base;
}

function resolveSearchProductsArgs(raw: SearchProductsInputRaw): SearchProductsArgs {
  const trimOrUndef = (s: string | null | undefined) => {
    if (s == null) return undefined;
    const t = s.trim();
    return t === '' ? undefined : t;
  };
  return {
    platform: raw.platform ?? 'both',
    keyword: trimOrUndef(raw.keyword ?? raw.q ?? undefined),
    status: raw.status ?? 'active',
    priceMin: raw.priceMin ?? undefined,
    priceMax: raw.priceMax ?? undefined,
    sort: raw.sort ?? 'relevance',
    pageSize: raw.pageSize ?? undefined,
    cursor: trimOrUndef(raw.cursor ?? undefined),
    includeRaw: raw.includeRaw === true,
  };
}

function parseSearchProductsArgs(input: unknown): SearchProductsArgs {
  const parsed = searchProductsArgsSchema.safeParse(widenSearchProductsInput(input));
  if (!parsed.success) {
    throw new Error(`Invalid search-products input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return resolveSearchProductsArgs(parsed.data);
}

export const searchProductsTool = createTool({
  id: 'search-products',
  /** Groq: strict tool input forces all schema properties to be sent; disable for optional filters. */
  strict: false,
  description:
    'Search products. All params optional ({} ok). Each row has shopId for other product tools. Filters: platform, keyword, status, price, sort, pageSize, cursor, includeRaw. includeRaw:true caps pageSize at 10 (full marketplace payloads are for spot-checking a few products, not bulk export).',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z
      .string()
      .uuid()
      .describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: searchProductsInputSchema,
  inputExamples: [
    { input: {} },
    { input: { platform: 'tiktok', keyword: 'shirt', pageSize: 10 } },
    { input: { platform: 'both', pageSize: 10, cursor: null } },
    { input: { includeRaw: true, pageSize: 10 } },
  ],
  outputSchema: z.object({
    products: z.array(productSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    perPlatform: perPlatformSchema,
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = parseSearchProductsArgs(input);

    const platform = args.platform ?? 'both';
    const targets: Array<'shopee' | 'tiktok'> =
      platform === 'both' ? ['shopee', 'tiktok'] : [platform];

    // includeRaw carries each product's full marketplace API JSON payload — same token-budget risk
    // fixed for search-orders (see the comment there): cap the page size much tighter when requested.
    const totalPageSize = clampPageSize(args.pageSize, 10, args.includeRaw ? 10 : 100);
    const sliceSizes = splitPageSize(totalPageSize, targets.length);

    const cursor: CursorState = decodeCursor(args.cursor);

    const baseOpts: SearchOptions = {
      keyword: args.keyword,
      status: args.status,
      priceMin: args.priceMin,
      priceMax: args.priceMax,
      sort: args.sort,
      pageSize: 1,
      includeRaw: args.includeRaw,
    };

    const perPlatform: { shopee?: PlatformReport; tiktok?: PlatformReport } = {};
    const products: NormalizedProduct[] = [];
    const nextCursor: CursorState = {};

    const explicitSingle = platform !== 'both';

    const tasks = targets.map((p, idx) => async () => {
      const slicePageSize = sliceSizes[idx] ?? totalPageSize;
      const opts: SearchOptions = { ...baseOpts, pageSize: slicePageSize };

      try {
        let result: PlatformPageResult | null = null;

        if (p === 'shopee') {
          const shopeeConns = await listConnectionsByTenant(tenantId, ['shopee']);
          if (shopeeConns.length === 0) {
            result = null;
          } else {
            const legacyOffset =
              cursor.shopee?.offset !== undefined && !cursor.shopee?.byShop
                ? cursor.shopee.offset
                : undefined;
            const byShopIn = cursor.shopee?.byShop ?? {};
            const perShopPageSize =
              shopeeConns.length === 1
                ? slicePageSize
                : Math.max(1, Math.floor(slicePageSize / shopeeConns.length));

            const merged: NormalizedProduct[] = [];
            let combinedHasMore = false;
            const nextByShop: Record<string, number> = {};

            for (let i = 0; i < shopeeConns.length; i++) {
              const conn = shopeeConns[i];
              const shopKey = conn.external_shop_id;
              let offset = byShopIn[shopKey];
              if (offset === undefined && legacyOffset !== undefined && i === 0) {
                offset = legacyOffset;
              }
              if (offset === undefined) offset = 0;

              const client = await getShopeeClient(conn.external_shop_id);
              const page = await searchShopeeProducts(client, {
                ...opts,
                pageSize: perShopPageSize,
                offset,
              });
              merged.push(...page.products);
              if (page.hasMore && typeof page.nextOffset === 'number') {
                combinedHasMore = true;
                nextByShop[shopKey] = page.nextOffset;
              }
            }

            let nextOffset: number | undefined;
            if (shopeeConns.length === 1 && typeof nextByShop[shopeeConns[0].external_shop_id] === 'number') {
              nextOffset = nextByShop[shopeeConns[0].external_shop_id];
            }

            result = {
              products: merged,
              hasMore: combinedHasMore,
              nextOffset,
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
              cursor.tiktok?.pageToken && !cursor.tiktok?.byShop
                ? cursor.tiktok.pageToken
                : undefined;
            const byShopIn = cursor.tiktok?.byShop ?? {};
            const perShopPageSize = Math.max(1, Math.floor(slicePageSize / Math.max(1, slices.length)));

            const merged: NormalizedProduct[] = [];
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
              const page = await searchTiktokProducts(client, {
                ...opts,
                pageSize: perShopPageSize,
                pageToken,
                shopCipher: cipher,
              });
              merged.push(...page.products);
              if (page.hasMore && page.nextPageToken) {
                combinedHasMore = true;
                nextByShop[cursorKey] = page.nextPageToken;
              }
            }

            let nextPageToken: string | undefined;
            if (slices.length === 1 && nextByShop[slices[0].cursorKey]) {
              nextPageToken = nextByShop[slices[0].cursorKey];
            }

            result = {
              products: merged,
              hasMore: combinedHasMore,
              nextPageToken,
              nextTiktokByShop: Object.keys(nextByShop).length ? nextByShop : undefined,
            };
          }
        }

        if (!result) {
          const message = `No ${p} connection found for tenant.`;
          if (explicitSingle) {
            throw new Error(message);
          }
          perPlatform[p] = { requested: true, skipped: message };
          return;
        }

        products.push(...result.products);
        perPlatform[p] = {
          requested: true,
          count: result.products.length,
          hasMore: result.hasMore,
        };

        if (result.hasMore) {
          if (p === 'shopee') {
            const byShop = result.nextShopeeByShop;
            if (byShop && Object.keys(byShop).length > 0) {
              nextCursor.shopee = { byShop };
            } else if (typeof result.nextOffset === 'number') {
              nextCursor.shopee = { offset: result.nextOffset };
            }
          }
          if (p === 'tiktok') {
            const byShop = result.nextTiktokByShop;
            if (byShop && Object.keys(byShop).length > 0) {
              nextCursor.tiktok = { byShop };
            } else if (result.nextPageToken) {
              nextCursor.tiktok = { pageToken: result.nextPageToken };
            }
          }
        }
      } catch (err) {
        const message = describeError(err);
        if (explicitSingle) {
          throw err;
        }
        perPlatform[p] = { requested: true, error: message };
      }
    });

    await Promise.all(tasks.map((run) => run()));

    const encoded = encodeCursor(nextCursor);
    const hasMore = Boolean(encoded);

    return {
      products,
      nextCursor: encoded,
      hasMore,
      perPlatform,
    };
  },
});
