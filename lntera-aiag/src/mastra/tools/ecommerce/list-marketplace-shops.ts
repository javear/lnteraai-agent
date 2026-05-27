import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listTenantMarketplaceShops } from '../../integrations/shared/marketplace-shops';

const platformFilterEnum = z.enum(['both', 'shopee', 'tiktok']);

/** Execute-time validation; Groq often sends `null` for omitted optional fields. */
const listMarketplaceShopsArgsSchema = z
  .object({
    platform: platformFilterEnum.nullish(),
    refresh: z.boolean().nullish(),
  })
  .passthrough();

/** Provider-facing schema: loose map so `{}` and partial/null args validate (Groq strict). */
const listMarketplaceShopsInputSchema = z.record(z.string(), z.unknown());

const shopRowSchema = z.object({
  platform: z.enum(['shopee', 'tiktok']),
  shopId: z.string(),
  name: z.string().nullable(),
  region: z.string().nullable(),
  shopCode: z.string().optional(),
  status: z.enum(['ready', 'needs_reconnect']),
});

const outputSchema = z.object({
  success: z.literal(true),
  shops: z.array(shopRowSchema),
  summary: z.object({
    total: z.number(),
    shopee: z.number(),
    tiktok: z.number(),
    needsReconnect: z.number(),
  }),
  refreshed: z.boolean().optional(),
  refreshErrors: z
    .array(
      z.object({
        platform: z.enum(['shopee', 'tiktok']),
        shopId: z.string().optional(),
        message: z.string(),
      }),
    )
    .optional(),
});

export const listMarketplaceShopsTool = createTool({
  id: 'list-marketplace-shops',
  strict: false,
  description:
    'List all marketplace shops linked to the tenant in requestContext. Returns only safe fields: **platform**, **shopId**, **name**, **region**, optional **shopCode** (TikTok Seller Center code), and **status** (`ready` | `needs_reconnect`). Never returns access tokens, refresh tokens, shop cipher, open_id, or raw connection payloads. **shopId** is what other ecommerce tools expect: Shopee numeric shop id; TikTok shop **id** or Seller Center **code** (not ROW cipher). Shopee **name**/**region** are loaded from DB; if **name** is missing, the tool automatically calls Shopee `get_shop_info` and saves it (no `refresh` flag needed). **Input:** `{ platform?: "both"|"shopee"|"tiktok", refresh?: boolean }` — `refresh: true` re-fetches all Shopee/TikTok shop profiles from the APIs.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema: listMarketplaceShopsInputSchema,
  inputExamples: [{ input: {} }, { input: { platform: 'tiktok' } }, { input: { refresh: true } }],
  outputSchema,
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = listMarketplaceShopsArgsSchema.parse(input ?? {});
    const result = await listTenantMarketplaceShops({
      tenantId,
      platform: args.platform ?? 'both',
      refresh: args.refresh === true,
    });
    return { success: true as const, ...result };
  },
});
