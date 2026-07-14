// Automatic ("conventional") RAG: embeds the user's latest message and injects the FEW most closely
// matched knowledge-base chunks as system context BEFORE the model runs — regardless of whether the
// model itself decides to call the `search-knowledge` TOOL. The tool stays as-is for on-demand/deeper
// follow-up lookups (e.g. "check that again from a different angle"); this processor is the baseline
// grounding every turn gets for free, so retrieval doesn't depend entirely on a smaller/weaker model in
// the Groq chain correctly recognizing "this needs my knowledge base."
//
// Every early-return path logs WHY — this processor is silent-by-default otherwise (it must never
// throw and break a chat turn over a FalkorDB/embedding hiccup), which made it completely
// undiagnosable when it wasn't visibly grounding answers. Log lines are the only way to tell "found
// nothing relevant" apart from "never actually ran" from Railway logs.
import type { ProcessInputArgs, Processor } from '@mastra/core/processors';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { embedText } from '../integrations/embeddings/qwen-embeddings';
import { searchTenantKnowledge } from '../integrations/knowledge/graph-read';
import { ensureGraphFresh } from '../integrations/knowledge/eviction';
import { touchActivity } from '../integrations/knowledge/quota';
import { logErrorBrief } from '../logger/compact-error';

// Matches the search-knowledge TOOL's own default (5) — a smaller net here previously risked missing
// a relevant chunk that ranked #4/#5 while the tool's wider search still found it.
const TOP_K = 5;
// Below this length a message is almost never a knowledge-seeking question ("hi", "thanks", "ok") —
// skip the embed+search round trip entirely rather than pay it on every single turn.
const MIN_QUERY_CHARS = 8;

function formatContext(chunks: Array<{ text: string }>): string {
  const body = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n');
  // Assertive, not hedged — a hedged "may not be relevant, maybe use the tool instead" framing gives a
  // weaker model an easy excuse to ignore this entirely instead of actually reading and using it.
  return `The following are excerpts from this business's OWN knowledge base, already retrieved because they closely match the current question. Use them directly to answer if they're relevant — this IS their data, not a suggestion to go look elsewhere. Only call the search-knowledge tool if you need MORE detail than what's here or a different angle:\n\n${body}`;
}

export const knowledgePreRetrievalProcessor = {
  id: 'knowledge-pre-retrieval',
  name: 'Automatic knowledge-base pre-retrieval',

  async processInput({ requestContext, messageList }: ProcessInputArgs) {
    try {
      const tenantIdRaw = requestContext?.get?.(TENANT_MASTER_ID_KEY);
      const tenantId = typeof tenantIdRaw === 'string' && tenantIdRaw ? tenantIdRaw : null;
      if (!tenantId) {
        console.info('[knowledge] pre-retrieval: skip — no tenant_master_id on requestContext');
        return messageList;
      }

      const query = messageList.getLatestUserContent()?.trim();
      if (!query || query.length < MIN_QUERY_CHARS) {
        console.info(`[knowledge] pre-retrieval: skip tenant=${tenantId} — query too short (${query?.length ?? 0} chars)`);
        return messageList;
      }

      const rebuilding = await ensureGraphFresh(tenantId);
      if (rebuilding) {
        console.info(`[knowledge] pre-retrieval: skip tenant=${tenantId} — graph is rebuilding`);
        return messageList;
      }

      void touchActivity(tenantId).catch(() => undefined);

      const embedding = await embedText(query);
      const { chunks } = await searchTenantKnowledge(tenantId, embedding, TOP_K);
      if (chunks.length === 0) {
        console.info(`[knowledge] pre-retrieval: skip tenant=${tenantId} — no matching chunks for query "${query.slice(0, 80)}"`);
        return messageList;
      }

      console.info(`[knowledge] pre-retrieval: injecting ${chunks.length} chunk(s) tenant=${tenantId}`);
      messageList.addSystem(formatContext(chunks), 'knowledge-pre-retrieval');
      return messageList;
    } catch (err) {
      // Best-effort — a FalkorDB/embedding hiccup must never block the chat turn itself.
      logErrorBrief('[knowledge] pre-retrieval failed', err);
      return messageList;
    }
  },
} satisfies Processor<'knowledge-pre-retrieval'>;
