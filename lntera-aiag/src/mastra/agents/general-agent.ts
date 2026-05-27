import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import {
  listMarketplaceShopsTool,
  searchProductsTool,
  searchOrdersTool,
  confirmOrderFulfillmentTool,
  createFulfillmentPackageTool,
  getOrderDetailsTool,
  getShippingLabelsTool,
  getProductDetailsTool,
  updateProductAttributesTool,
  updateProductPriceTool,
  updateProductStockTool,
  archiveProductTool,
  startProductDraftTool,
  updateProductDraftTool,
  getProductDraftTool,
  listProductDraftsTool,
  publishProductDraftTool,
  discardProductDraftTool,
} from '../tools/ecommerce';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { groqReasoningRollingCompatProcessor } from '../processors';
import {
  buildAvailableGroqChain,
  GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY,
  readGroqChainOrderFromRequestContext,
} from '../models/groq-model-chain';

export const generalAgent = new Agent({
  id: 'general-agent',
  name: 'General Agent',
  /** Allows `processAPIError` retries when sanitizing history after an unexpected 400. */
  maxProcessorRetries: 2,
  inputProcessors: [groqReasoningRollingCompatProcessor],
  errorProcessors: [groqReasoningRollingCompatProcessor],
  instructions: `You are a helpful marketplace assistant for sellers.

Operating modes (requestContext.mode):
- Default "passive": a human message. Use tools for live merchant data. Read each tool's description, schema, and examples before calling — do not invent tool behavior here. Do not ask the user for parameters a tool documents as required or returns in \`missing[]\`; call the tool and act on its output.
- "active": a marketplace webhook payload (not a human question). Rules below.

Passive:
- Concise but thorough; mirror the user's language; Markdown when it helps readability.
- If you cannot verify something, say so — do not fabricate.
- Ask one focused clarifying question only when the request is genuinely ambiguous and no tool can resolve it.

Discord (requestContext.channel === "discord"):
- Final reply: plain text or markdown only — no JSON, function calls, or schema in the answer.
- Keep replies tight; under 2000 characters when possible.
- Never invent URLs, attachment links, or message ids.

Active mode (requestContext.mode === "active"):
- Transcribe the webhook into a short seller-friendly Discord notification. Do NOT ask clarifying questions.
- requestContext.marketplace describes the source (platform, category, code).
- Mirror the tenant's language; default to English if unknown. Friendly, professional tone — no greetings like "Hi there!".
- Lead with the most important fact; optional 3–5 bullets. Max 1800 characters; never echo raw JSON.
- You MAY call at most one tool to enrich if an order id is present and extra detail materially helps. Skip tools for trivial status-only events.
- If data is missing, summarize best-effort and note what was unavailable — never reply with a question.`,
  model: ({ requestContext }) => {
    const pinned = requestContext?.get?.('groqModel');
    const pinnedStr = typeof pinned === 'string' ? pinned : undefined;
    const tenantId = requestContext?.get?.(TENANT_MASTER_ID_KEY);
    const tenant = typeof tenantId === 'string' ? tenantId : null;
    const chainOrder = readGroqChainOrderFromRequestContext(requestContext);
    const largeContext = requestContext?.get?.(GROQ_MODEL_CHAIN_LARGE_CONTEXT_KEY) === true;
    return buildAvailableGroqChain({
      tenantId: tenant,
      pinned: pinnedStr,
      largeContext,
      chainOrder: chainOrder ?? undefined,
    });
  },
  memory: new Memory(),
  tools: {
    [listMarketplaceShopsTool.id]: listMarketplaceShopsTool,
    [searchProductsTool.id]: searchProductsTool,
    [searchOrdersTool.id]: searchOrdersTool,
    [confirmOrderFulfillmentTool.id]: confirmOrderFulfillmentTool,
    [createFulfillmentPackageTool.id]: createFulfillmentPackageTool,
    [getOrderDetailsTool.id]: getOrderDetailsTool,
    [getShippingLabelsTool.id]: getShippingLabelsTool,
    [getProductDetailsTool.id]: getProductDetailsTool,
    [updateProductAttributesTool.id]: updateProductAttributesTool,
    [updateProductPriceTool.id]: updateProductPriceTool,
    [updateProductStockTool.id]: updateProductStockTool,
    [archiveProductTool.id]: archiveProductTool,
    [startProductDraftTool.id]: startProductDraftTool,
    [updateProductDraftTool.id]: updateProductDraftTool,
    [getProductDraftTool.id]: getProductDraftTool,
    [listProductDraftsTool.id]: listProductDraftsTool,
    [publishProductDraftTool.id]: publishProductDraftTool,
    [discardProductDraftTool.id]: discardProductDraftTool,
  },
});
