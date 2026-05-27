import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import { listDrafts } from '../../integrations/shared/product-drafts';

const platformEnum = z.enum(['shopee', 'tiktok']);

const inputSchema = z
  .object({
    platform: platformEnum.optional(),
    shopId: z.string().min(1).optional(),
  })
  .passthrough();

export const listProductDraftsTool = createTool({
  id: 'list-product-drafts',
  description:
    'List open product drafts for this tenant. Without filters returns drafts across both platforms (TikTok native drafts + local Shopee drafts). Use this when the user asks "show my drafts" or wants to resume one. **Input:** `{ platform?, shopId? }`. Returns `drafts[]` with `draftId`, `platform`, `shopId`, `data.title` and `updatedAt`.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    { input: {} },
    { input: { platform: 'tiktok' } },
    { input: { platform: 'shopee', shopId: '999111' } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});
    const result = await listDrafts({
      tenantId,
      platforms: args.platform ? [args.platform] : undefined,
      shopId: args.shopId,
    });
    return {
      success: true,
      drafts: result.drafts.map((d) => ({
        draftId: d.draftId,
        platform: d.platform,
        shopId: d.shopId,
        status: d.status,
        title: d.data.title,
        updatedAt: d.updatedAt,
        nativeDraft: d.nativeDraft,
      })),
      errors: result.errors,
    };
  },
});
