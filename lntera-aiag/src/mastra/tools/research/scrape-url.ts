// Agent-callable: fetch the full content of a SPECIFIC url the user gave (an article, a report, a
// page), via Parallel.ai's extract API — handles JS-heavy pages and PDFs the agent can't fetch itself.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { parallelExtract, getParallelApiKey } from '../../integrations/research/parallel-client';

// Same rationale as truncateForAgent in studio/tools.ts — a full article/PDF can be huge; keep head +
// tail so the agent still sees the conclusion even when the middle is cut.
const MAX_CONTENT_CHARS = 8000;

const paramsSchema = z.object({
  url: z.string().url(),
});

export const scrapeUrlTool = createTool({
  id: 'scrape-url',
  strict: false,
  description:
    'Fetch the full text content of a specific URL the user gave you (an article, a report, a web page). Use when the user wants you to research from that exact link, not a general web search. Pass url: the full URL, including https://.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { url: 'https://example.com/article' } }],
  outputSchema: z.object({
    url: z.string(),
    title: z.string().nullable(),
    content: z.string().nullable(),
    notice: z.string().optional(),
  }),
  execute: async (input, context) => {
    requireTenantContext(context);
    if (!getParallelApiKey()) {
      return { url: '', title: null, content: null, notice: 'URL scraping is not configured on this server.' };
    }
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) throw new Error('url is required — a full URL including https://.');

    const [result] = await parallelExtract([parsed.data.url]);
    if (!result || !result.content) {
      return { url: parsed.data.url, title: null, content: null, notice: 'Could not extract content from that URL.' };
    }
    return {
      url: result.url || parsed.data.url,
      title: result.title,
      content: truncateForAgent(result.content),
    };
  },
});

function truncateForAgent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  const headLen = 2000;
  const tailLen = MAX_CONTENT_CHARS - headLen;
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tailLen)}`;
}
