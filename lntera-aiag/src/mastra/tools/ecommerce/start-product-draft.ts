import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { DISCORD_IMAGE_URL_TOOL_HINT } from '../../integrations/shared/discord-attachment-urls';
import {
  evaluateDraftReadiness,
  productDraftInputSchema,
  startDraft,
} from '../../integrations/shared/product-drafts';

const platformEnum = z.enum(['shopee', 'tiktok']);

const inputSchema = z
  .object({
    platform: platformEnum,
    shopId: z.string().min(1),
    initial: productDraftInputSchema.optional(),
  })
  .passthrough();

export const startProductDraftTool = createTool({
  id: 'start-product-draft',
  description:
    `Start a product draft; returns draftId. ${DISCORD_IMAGE_URL_TOOL_HINT}`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    {
      input: {
        platform: 'tiktok',
        shopId: '7123456789',
        initial: { title: 'Linen Shirt', categoryId: '601400', price: 119000 },
      },
    },
    { input: { platform: 'shopee', shopId: '999111' } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});
    const initial = args.initial ?? {};
    const record = await startDraft({
      platform: args.platform,
      tenantId,
      shopId: args.shopId,
      initial,
      toolContext: context as import('../../integrations/shared/discord-attachment-urls').ToolContextLike,
    });
    const readiness = evaluateDraftReadiness(record);
    return {
      success: true,
      draftId: record.draftId,
      platform: record.platform,
      shopId: record.shopId,
      status: record.status,
      data: record.data,
      readiness,
      missing: readiness.missing,
      nativeDraft: record.nativeDraft,
    };
  },
});
