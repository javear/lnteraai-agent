import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  requireTenantContext,
  TENANT_MASTER_ID_KEY,
} from '../../integrations/shared/marketplace-auth';
import {
  discardDraft,
  getDraft,
} from '../../integrations/shared/product-drafts';
import {
  isToolConfirmationRequired,
  assertConfirmed,
  TOOL_TWO_STEP_CONFIRM_DESC,
} from '../../integrations/shared/confirm';

const inputSchema = z
  .object({
    draftId: z.string().min(1),
    confirm: z.boolean().optional(),
  })
  .passthrough();

const TOOL_ID = 'discard-product-draft';

export const discardProductDraftTool = createTool({
  id: TOOL_ID,
  description:
    `Discard an in-progress product draft. ${TOOL_TWO_STEP_CONFIRM_DESC} TikTok: deletes the draft product; Shopee: marks the local row \`discarded\`. **Input:** \`{ draftId, confirm? }\`.`,
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid(),
  }),
  inputSchema,
  inputExamples: [
    { input: { draftId: 'sp-123e4567-e89b-12d3-a456-426614174000' } },
    { input: { draftId: 'tt-1729012345678901234', confirm: true } },
  ],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const args = inputSchema.parse(input ?? {});

    try {
      const record = await getDraft(args.draftId, tenantId);
      assertConfirmed({
        confirm: args.confirm,
        toolId: TOOL_ID,
        preview: {
          draftId: record.draftId,
          platform: record.platform,
          shopId: record.shopId,
          title: record.data.title,
        },
        message: `Confirm to discard ${record.platform} draft "${record.data.title ?? '(untitled)'}".`,
      });
      await discardDraft(args.draftId, tenantId);
      return { success: true, draftId: record.draftId, message: 'Draft discarded.' };
    } catch (e) {
      if (isToolConfirmationRequired(e)) return e.payload;
      throw e;
    }
  },
});
