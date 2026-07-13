// Agent-callable: kick off a comprehensive Research report (internal knowledge + web search synthesis
// into a persisted, chart-and-citation-rich document). Deliberately async — a real report gathers
// several sources and runs one LLM synthesis pass, too slow to hold open a chat reply for (same
// rationale as studio-deploy-preview's webapp path) — this tool creates the row and hands the actual
// work to generate-research-report (an Inngest job with retries), returning immediately.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { AUTH_USER_ID_KEY } from '../../server/auth/tenant-context-middleware';
import { createResearchReport } from '../../integrations/research/reports-repo';
import { inngest } from '../../inngest/client';

const paramsSchema = z.object({
  topic: z.string().min(1),
  instructions: z.string().optional(),
});

export const generateResearchReportTool = createTool({
  id: 'generate-research-report',
  strict: false,
  description:
    "Start building a comprehensive research report/analysis on a topic — gathers the business's own internal documents/knowledge AND searches the web, then synthesizes a report with sections, charts (including forecasts when relevant), and cited sources. Use when the user asks for research, analysis, a report, or a prediction/forecast on some topic (e.g. \"research our price forecast for next year using our internal docs and any relevant news\"). This takes a while — tell the user you're building it now and they'll be notified when it's ready; never claim the report is done in this same reply. Pass topic: what to research, phrased clearly. instructions: optional extra guidance (e.g. \"focus on the next 12 months\", \"compare against our internal forecast\").",
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
    [AUTH_USER_ID_KEY]: z.string().uuid().optional().describe('UUID of the requesting auth user, if known.'),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [
    { input: { topic: 'Price prediction for our main product line over the next year' } },
    {
      input: {
        topic: 'Coffee bean supply chain disruption risk',
        instructions: 'Compare against our internal forecast document and focus on the next 6 months.',
      },
    },
  ],
  outputSchema: z.object({
    ok: z.boolean(),
    reportId: z.string().nullable(),
    summaryText: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const parsed = paramsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, reportId: null, summaryText: 'Tell me what topic you want researched.' };
    }

    // Whoever is chatting right now — so the "report ready" email goes to just them, not every user
    // on the tenant workspace (unlike the in-app notification, which is tenant-wide).
    let authUserId: string | null = null;
    try {
      const v = context?.requestContext?.get?.(AUTH_USER_ID_KEY);
      authUserId = typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch {
      authUserId = null;
    }

    const report = await createResearchReport(tenantId, parsed.data.topic, authUserId);
    await inngest.send({
      name: 'research/report.requested',
      data: {
        tenantId,
        reportId: report.id,
        topic: parsed.data.topic,
        instructions: parsed.data.instructions ?? null,
        authUserId,
      },
    });

    return {
      ok: true,
      reportId: report.id,
      summaryText: `I'm building your research report on "${parsed.data.topic}" now — gathering internal knowledge and searching the web. I'll notify you here as soon as it's ready.`,
    };
  },
});
