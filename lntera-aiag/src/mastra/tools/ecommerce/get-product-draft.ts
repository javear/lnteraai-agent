import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import {
  evaluateDraftReadiness,
  getDraft,
} from '../../integrations/shared/product-drafts';

const inputSchema = z
  .object({
    draftId: z.string().min(1),
  })
  .passthrough();

export const getProductDraftTool = createTool({
  id: 'get-product-draft',
  description:
    'Fetch a draft by id. Returns the full draft `data`, current `status`, and `readiness.missing[]` showing which required fields are still unset for the target platform. **Input:** `{ draftId }`.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    { input: { draftId: 'tt-1729012345678901234' } },
    { input: { draftId: 'sp-123e4567-e89b-12d3-a456-426614174000' } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});
    const record = await getDraft(args.draftId, tenantId);
    const readiness = evaluateDraftReadiness(record);
    return {
      success: true,
      draftId: record.draftId,
      platform: record.platform,
      shopId: record.shopId,
      status: record.status,
      data: record.data,
      publishedItemId: record.publishedItemId,
      readiness,
      missing: readiness.missing,
      nativeDraft: record.nativeDraft,
      updatedAt: record.updatedAt,
    };
  },
});
