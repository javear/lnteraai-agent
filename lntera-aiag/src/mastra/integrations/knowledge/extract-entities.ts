// Entity/relationship extraction for GraphRAG ingestion — reuses the TENANT'S OWN connected LLM
// (same Portkey chain as general-agent/technical-agent), so extraction is BYOK cost, not platform cost.
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveActiveTenantProviders } from '../portkey/resolve-tenant-model';
import { buildAvailablePortkeyLlmChain } from '../portkey/portkey-llm-chain';

const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        type: z.string().min(1).max(50),
      }),
    )
    .max(30),
  relationships: z
    .array(
      z.object({
        from: z.string().min(1).max(200),
        to: z.string().min(1).max(200),
        type: z.string().min(1).max(50),
      }),
    )
    .max(30),
});

export type ExtractedGraph = z.infer<typeof extractionSchema>;

const EXTRACTOR_INSTRUCTIONS = `Extract a knowledge graph from the given text chunk for retrieval-augmented search.

- entities: the distinct people, organizations, products, places, dates, or concepts mentioned. Use short canonical names (e.g. "Acme Corp" not "the company" or "Acme Corporation Inc."); reuse the exact same name string for the same real-world thing so entities can be deduplicated later.
- relationships: factual connections between two entities already listed (e.g. {from:"Acme Corp", to:"Jane Doe", type:"employs"}). Only include relationships explicitly stated or clearly implied in the text — never invent facts.
- If the text has no clear entities (e.g. pure boilerplate), return empty arrays.`;

/** Throws if the tenant has no connected LLM provider — ingestion requires one, same as chat. */
export async function extractEntitiesAndRelationships(tenantId: string, text: string): Promise<ExtractedGraph> {
  const providers = await resolveActiveTenantProviders(tenantId);
  if (providers.length === 0) {
    throw new Error('No connected LLM provider — connect one before uploading knowledge documents.');
  }

  const chain = buildAvailablePortkeyLlmChain({
    providers,
    tenantId,
    // Structured output has the same reliability requirement as tool-calling: confirmed live that
    // llama-3.1-8b-instant rejects `response_format: json_schema` outright on Groq. largeContext
    // orders the big models first (same fix technical-agent.ts uses for tool-calling reliability),
    // sinking that model to last resort instead of paying a guaranteed-fail request on every chunk.
    largeContext: true,
    metadata: { tenant_id: tenantId, agent: 'knowledge-extractor' },
  });

  const extractor = new Agent({
    id: 'knowledge-extractor',
    name: 'Knowledge Extractor',
    instructions: EXTRACTOR_INSTRUCTIONS,
    model: chain,
  });

  const result = await extractor.generate([{ role: 'user', content: text }], {
    structuredOutput: { schema: extractionSchema },
  });

  return result.object ?? { entities: [], relationships: [] };
}
