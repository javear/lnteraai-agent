// Builds one Research report: gathers the tenant's own internal knowledge (GraphRAG) + external web
// context (Parallel.ai search + extract), then runs ONE synthesis pass through research-report-agent
// to produce a structured { sections, charts, images, citations } document. Triggered by
// generate-research-report (the agent tool in tools/research/generate-report.ts), which creates the DB
// row and returns to the chat immediately — this is the slow part, kept off that request/response cycle.
//
// Steps run SEQUENTIALLY (no Promise.all) to keep this function's own step-concurrency footprint
// minimal regardless of exact Inngest-plan scoping semantics (see PR #147 / the free-tier concurrency
// convention every function here follows).
import { RequestContext } from '@mastra/core/request-context';
import { inngest } from '../client';
import { researchReportAgent } from '../../agents/research-report-agent';
import { TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { embedText } from '../../integrations/embeddings/qwen-embeddings';
import { searchTenantKnowledge } from '../../integrations/knowledge/graph-read';
import { ensureGraphFresh } from '../../integrations/knowledge/eviction';
import { parallelSearchBestEffort, parallelExtractBestEffort } from '../../integrations/research/parallel-client';
import {
  markResearchReportReady,
  markResearchReportFailed,
  type ResearchReportContent,
} from '../../integrations/research/reports-repo';
import { deliverTenantWebNotification } from '../../active-mode/web-delivery';
import { stripReasoning } from '../../integrations/shared/strip-reasoning';

interface GenerateReportEventData {
  tenantId: string;
  reportId: string;
  topic: string;
  instructions: string | null;
}

const MAX_WEB_RESULTS = 6;
const MAX_EXTRACT_URLS = 3;
const MAX_KNOWLEDGE_CHUNKS = 8;
// Per-source truncation so the synthesis prompt stays bounded even with several extracted pages.
const MAX_EXTRACT_CHARS = 4000;

export const generateResearchReportFn = inngest.createFunction(
  {
    id: 'generate-research-report',
    concurrency: [{ limit: 4 }, { key: 'event.data.tenantId', limit: 1 }],
    retries: 2,
    triggers: [{ event: 'research/report.requested' }],
  },
  async ({ event, step }) => {
    const { tenantId, reportId, topic, instructions } = event.data as GenerateReportEventData;

    try {
      const knowledgeChunks = await step.run('search-knowledge', async () => {
        const rebuilding = await ensureGraphFresh(tenantId);
        if (rebuilding) return [] as string[];
        const embedding = await embedText(topic);
        const { chunks } = await searchTenantKnowledge(tenantId, embedding, MAX_KNOWLEDGE_CHUNKS);
        return chunks.map((c) => c.text);
      });

      const webResults = await step.run('web-search', () =>
        parallelSearchBestEffort({ objective: instructions ? `${topic} — ${instructions}` : topic, searchQueries: [topic], maxResults: MAX_WEB_RESULTS }),
      );

      const extracted = await step.run('extract-top-sources', () =>
        parallelExtractBestEffort(webResults.slice(0, MAX_EXTRACT_URLS).map((r) => r.url)),
      );

      const content = await step.run('synthesize', async () => {
        const prompt = buildSynthesisPrompt({ topic, instructions, knowledgeChunks, webResults, extracted });
        const requestContext = new RequestContext();
        requestContext.set(TENANT_MASTER_ID_KEY, tenantId);
        const answer = (await researchReportAgent.generate(prompt, { requestContext, maxSteps: 1 })) as {
          text?: unknown;
          tripwire?: unknown;
        };
        if (answer.tripwire || typeof answer.text !== 'string') {
          throw new Error('The report writer did not produce a response.');
        }
        return parseReportJson(stripReasoning(answer.text));
      });

      await step.run('save-and-notify', async () => {
        await markResearchReportReady(reportId, content);
        await deliverTenantWebNotification({
          tenantId,
          heading: 'Your research report is ready',
          text: `Your research report on "${topic}" is ready to view.`,
          kind: 'insight',
          discord: true,
          actions: [{ id: 'view', label: 'View report', kind: 'link', href: `/reports/${reportId}`, style: 'primary' }],
        });
      });

      return { ok: true as const, reportId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markResearchReportFailed(reportId, message).catch(() => undefined);
      await deliverTenantWebNotification({
        tenantId,
        heading: 'Research report failed',
        text: `I couldn't finish your research report on "${topic}" this time. You can ask me to try again.`,
        kind: 'insight',
        discord: true,
      }).catch(() => undefined);
      return { ok: false as const, reportId, error: message };
    }
  },
);

function buildSynthesisPrompt(input: {
  topic: string;
  instructions: string | null;
  knowledgeChunks: string[];
  webResults: Array<{ url: string; title: string; publishDate: string | null; excerpts: string[] }>;
  extracted: Array<{ url: string; title: string | null; content: string | null }>;
}): string {
  const parts: string[] = [`Topic: ${input.topic}`];
  if (input.instructions) parts.push(`Extra guidance from the user: ${input.instructions}`);

  if (input.knowledgeChunks.length > 0) {
    parts.push(
      '\n## Internal knowledge (from this business\'s own documents)\n' +
        input.knowledgeChunks.map((c, i) => `[Internal ${i + 1}] ${c}`).join('\n\n'),
    );
  } else {
    parts.push('\n## Internal knowledge\n(No relevant internal documents were found for this topic.)');
  }

  if (input.webResults.length > 0) {
    parts.push(
      '\n## Web search results\n' +
        input.webResults
          .map((r, i) => `[Web ${i + 1}] ${r.title} — ${r.url}${r.publishDate ? ` (${r.publishDate})` : ''}\n${r.excerpts.join(' ')}`)
          .join('\n\n'),
    );
  } else {
    parts.push('\n## Web search results\n(No web results were available.)');
  }

  const usableExtracts = input.extracted.filter((e) => e.content);
  if (usableExtracts.length > 0) {
    parts.push(
      '\n## Extracted full-page content (deeper detail on the top web sources above)\n' +
        usableExtracts
          .map((e) => `[Source: ${e.title ?? e.url} — ${e.url}]\n${truncate(e.content ?? '', MAX_EXTRACT_CHARS)}`)
          .join('\n\n'),
    );
  }

  return parts.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Parses the report agent's plain-text JSON reply. Strips an accidental code fence, then extracts the
 *  outermost {...} span (models occasionally add a stray leading/trailing word despite instructions).
 *  Falls back to a minimal single-section report rather than losing the whole run on a malformed reply. */
function parseReportJson(raw: string): ResearchReportContent {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Partial<ResearchReportContent>;
      return {
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
        charts: Array.isArray(parsed.charts) ? parsed.charts : [],
        images: Array.isArray(parsed.images) ? parsed.images : [],
        citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      };
    } catch {
      // fall through to the degraded-report fallback below
    }
  }
  return {
    sections: [{ heading: 'Report', body: unfenced || 'The report could not be generated in a readable format.' }],
    charts: [],
    images: [],
    citations: [],
  };
}
