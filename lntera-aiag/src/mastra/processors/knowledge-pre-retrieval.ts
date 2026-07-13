// Automatic ("conventional") RAG: embeds the user's latest message and injects the FEW most closely
// matched knowledge-base chunks as system context BEFORE the model runs — regardless of whether the
// model itself decides to call the `search-knowledge` TOOL. The tool stays as-is for on-demand/deeper
// follow-up lookups (e.g. "check that again from a different angle"); this processor is the baseline
// grounding every turn gets for free, so retrieval doesn't depend entirely on a smaller/weaker model in
// the Groq chain correctly recognizing "this needs my knowledge base."
//
// Deliberately capped to a SMALL top-k (not the tool's default 5) and completely silent when nothing
// matches — this is meant to ground obviously-relevant turns cheaply, not replace deliberate, deeper
// tool-driven search.
import type { ProcessInputArgs, Processor } from '@mastra/core/processors';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { embedText } from '../integrations/embeddings/qwen-embeddings';
import { searchTenantKnowledge } from '../integrations/knowledge/graph-read';
import { ensureGraphFresh } from '../integrations/knowledge/eviction';
import { touchActivity } from '../integrations/knowledge/quota';
import { logErrorBrief } from '../logger/compact-error';

const TOP_K = 3;
// Below this length a message is almost never a knowledge-seeking question ("hi", "thanks", "ok") —
// skip the embed+search round trip entirely rather than pay it on every single turn.
const MIN_QUERY_CHARS = 8;

function formatContext(chunks: Array<{ text: string }>): string {
  const body = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n');
  return `Possibly relevant excerpts from this business's own knowledge base (may not all be relevant to the current question — use judgment, and prefer the search-knowledge tool if you need to dig deeper or search a different angle):\n\n${body}`;
}

export const knowledgePreRetrievalProcessor = {
  id: 'knowledge-pre-retrieval',
  name: 'Automatic knowledge-base pre-retrieval',

  async processInput({ requestContext, messageList }: ProcessInputArgs) {
    try {
      const tenantIdRaw = requestContext?.get?.(TENANT_MASTER_ID_KEY);
      const tenantId = typeof tenantIdRaw === 'string' && tenantIdRaw ? tenantIdRaw : null;
      if (!tenantId) return messageList;

      const query = messageList.getLatestUserContent()?.trim();
      if (!query || query.length < MIN_QUERY_CHARS) return messageList;

      const rebuilding = await ensureGraphFresh(tenantId);
      if (rebuilding) return messageList;

      void touchActivity(tenantId).catch(() => undefined);

      const embedding = await embedText(query);
      const { chunks } = await searchTenantKnowledge(tenantId, embedding, TOP_K);
      if (chunks.length === 0) return messageList;

      messageList.addSystem(formatContext(chunks), 'knowledge-pre-retrieval');
      return messageList;
    } catch (err) {
      // Best-effort — a FalkorDB/embedding hiccup must never block the chat turn itself.
      logErrorBrief('[knowledge] pre-retrieval failed', err);
      return messageList;
    }
  },
} satisfies Processor<'knowledge-pre-retrieval'>;
