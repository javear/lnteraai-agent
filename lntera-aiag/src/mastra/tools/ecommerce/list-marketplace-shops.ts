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
    'List linked marketplace shops (platform, shopId, name, region, status). shopId is required for other product/order tools. Optional platform filter and refresh.',
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
