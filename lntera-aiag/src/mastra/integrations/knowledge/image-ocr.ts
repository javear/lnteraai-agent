// Vision-based text extraction for uploaded images — there is no vision-capability metadata anywhere
// in this codebase's model chain (see extract-entities.ts's model note on the same gap for structured
// output), so a plain provider chain risks landing on a text-only model that either errors on image
// content or silently ignores it. Mitigated by explicitly biasing the chain toward providers whose
// CURRENT model lineups are reliably vision-capable (Gemini/OpenAI/Anthropic) ahead of Groq/OpenRouter,
// whose curated free-tier chat models (groq-tool-models.ts) are mostly text-only.
import { Agent } from '@mastra/core/agent';
import { resolveActiveTenantProviders } from '../portkey/resolve-tenant-model';
import { buildAvailablePortkeyLlmChain } from '../portkey/portkey-llm-chain';
import { buildProviderPool } from '../../models/llm-model-chain';
import type { LlmProviderCode } from '../../models/llm-providers';

// buildAvailablePortkeyLlmChain's `chainOrder` takes actual MODEL codes (e.g. "gemini/gemini-2.0-
// flash"), not bare provider codes — confirmed live: passing provider codes directly resolves to an
// empty chain (every entry fails providerCodeForModel() and gets dropped). So the vision bias has to
// be built by re-ordering each provider's OWN model pool (buildProviderPool) before concatenating.
const VISION_PREFERRED_PROVIDER_ORDER: LlmProviderCode[] = ['gemini', 'openai', 'anthropic', 'groq', 'openrouter'];

const IMAGE_PROMPT =
  'Transcribe all readable text in this image exactly as written. If it is a photo, diagram, or chart ' +
  'rather than a text document, describe its content in detail instead so it can be searched later. ' +
  'Output only the transcription/description — no commentary.';

/** Throws if the tenant has no connected LLM provider, or if the resolved model can't process the
 *  image at all (surfaces as a normal ingestion failure — the document's error_message shows why). */
export async function extractImageText(tenantId: string, buffer: Buffer, mimeType: string): Promise<string> {
  const providers = await resolveActiveTenantProviders(tenantId);
  if (providers.length === 0) {
    throw new Error('No connected LLM provider — connect one before uploading images to your knowledge base.');
  }

  const orderedProviders = [...providers].sort(
    (a, b) => VISION_PREFERRED_PROVIDER_ORDER.indexOf(a.code) - VISION_PREFERRED_PROVIDER_ORDER.indexOf(b.code),
  );
  const chainOrder = orderedProviders.flatMap((p) => buildProviderPool(p, true));

  const chain = buildAvailablePortkeyLlmChain({
    providers,
    tenantId,
    largeContext: true,
    chainOrder,
    metadata: { tenant_id: tenantId, agent: 'knowledge-image-ocr' },
  });

  const vision = new Agent({
    id: 'knowledge-image-ocr',
    name: 'Knowledge Image OCR',
    instructions: 'You transcribe or describe uploaded images for a business knowledge base.',
    model: chain,
  });

  const result = await vision.generate([
    {
      role: 'user',
      content: [
        { type: 'text', text: IMAGE_PROMPT },
        { type: 'image', image: buffer.toString('base64'), mediaType: mimeType },
      ],
    },
  ]);

  const text = result.text?.trim();
  if (!text) {
    throw new Error('Could not extract any text or description from this image — try a clearer image, or connect a vision-capable provider (Gemini, OpenAI, or Anthropic).');
  }
  return text;
}
