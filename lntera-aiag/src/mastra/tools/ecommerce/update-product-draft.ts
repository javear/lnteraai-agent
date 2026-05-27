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
  updateDraft,
} from '../../integrations/shared/product-drafts';

const inputSchema = z
  .object({
    draftId: z.string().min(1),
    patch: productDraftInputSchema,
  })
  .passthrough();

export const updateProductDraftTool = createTool({
  id: 'update-product-draft',
  description:
    `Patch an existing draft (\`draftId\` from **start-product-draft**). Only fields in \`patch\` are updated. TikTok: \`partial_edit\`; Shopee: local row. Image URLs upload eagerly. ${DISCORD_IMAGE_URL_TOOL_HINT} **Input:** \`{ draftId, patch }\`. Returns \`missing[]\` before **publish-product-draft**.`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    { input: { draftId: 'sp-123e4567-e89b-12d3-a456-426614174000', patch: { title: 'Linen Shirt' } } },
    {
      input: {
        draftId: 'tt-1729012345678901234',
        patch: { price: 119000, stock: 25, weightGrams: 350 },
      },
    },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});
    const record = await updateDraft({
      draftId: args.draftId,
      tenantId,
      patch: args.patch,
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
    };
  },
});
