// Turn computed insight results into an Active-Agent message: the engine produced exact numbers +
// charts; here the LLM only NARRATES the deterministic facts (no fabricated figures), then we deliver
// text + charts into the tenant's Notifications chat. A deterministic fallback guarantees delivery
// even if the LLM is empty/rate-limited. Used by the Inngest scheduled run AND the run-now tool.
import { RequestContext } from '@mastra/core/request-context';
import { generalAgent } from '../agents/general-agent';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { logErrorBrief } from '../logger/compact-error';
import { AGENT_MODE_KEY, type AgentMode } from './notifier';
import { deliverTenantWebNotification } from './web-delivery';
import { runTenantInsights, type RunInsightsResult } from '../insights/engine';
import type { ChartSpec, InsightResult } from '../insights/types';

const INSIGHT_CONTEXT_KEY = 'insight';
const MAX_CHARTS = 6;

export interface InsightNotifyResult {
  status: 'delivered' | 'no_connection' | 'no_insights' | 'no_data';
  insightsReported: number;
  usedFallback?: boolean;
}

/** Run the tenant's subscribed insights and deliver the analysis (engine + narrate + deliver). */
export async function runAndNotifyInsights(
  tenantId: string,
  subscribedKeys: string[] | null,
): Promise<InsightNotifyResult> {
  const run = await runTenantInsights(tenantId, subscribedKeys);
  if (run.status === 'no_connection') return { status: 'no_connection', insightsReported: 0 };
  if (run.status === 'no_insights') return { status: 'no_insights', insightsReported: 0 };
  return notifyTenantOfInsights(tenantId, run);
}

export async function notifyTenantOfInsights(
  tenantId: string,
  run: RunInsightsResult,
): Promise<InsightNotifyResult> {
  const reportable = run.results.filter((r) => r.status === 'ok' || r.status === 'partial');
  const facts = buildFactsBlock(run.results);
  if (!facts.trim()) {
    return { status: 'no_data', insightsReported: 0 };
  }
  const charts = run.results.map((r) => r.chart).filter((c): c is ChartSpec => Boolean(c)).slice(0, MAX_CHARTS);

  const requestContext = new RequestContext();
  requestContext.set(TENANT_MASTER_ID_KEY, tenantId);
  requestContext.set('channel', 'web');
  requestContext.set(AGENT_MODE_KEY, 'active' satisfies AgentMode);
  requestContext.set(INSIGHT_CONTEXT_KEY, { keys: run.results.map((r) => r.key) });

  let answerText = '';
  try {
    const answer = (await generalAgent.generate(buildInsightPrompt(facts), { requestContext, maxSteps: 1 })) as {
      text?: unknown;
      tripwire?: unknown;
    };
    // A tripwire (e.g. no LLM key, regex guard) means no usable narrative — fall back to the
    // deterministic summary instead of posting the gate message next to the charts.
    if (!answer.tripwire && typeof answer.text === 'string') answerText = answer.text.trim();
  } catch (err) {
    logErrorBrief(`[active] insight narrate failed tenant=${tenantId}`, err);
  }
  const usedFallback = !answerText.trim();

  await deliverTenantWebNotification({
    tenantId,
    text: usedFallback ? buildFallbackText(run.results) : answerText,
    heading: 'Business insights',
    kind: 'insight',
    charts: charts.length ? charts : undefined,
    deterministic: false,
  });
  return { status: 'delivered', insightsReported: reportable.length, usedFallback };
}

function buildFactsBlock(results: InsightResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === 'error' || r.status === 'no_data') continue;
    const metricStr = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const caveat = r.dataCaveats?.length ? ` (note: ${r.dataCaveats.join('; ')})` : '';
    lines.push(`- ${r.label}: ${r.summary}${metricStr ? ` [${metricStr}]` : ''}${caveat}`);
  }
  return lines.join('\n');
}

function buildInsightPrompt(facts: string): string {
  return [
    "You are writing the seller's scheduled business-analysis update for their Active Agent chat.",
    'The facts below were computed from their live Shopee/TikTok data and are ACCURATE — never invent or change a number.',
    'Write a concise, warm, scannable update: a one-line opener, then short bullets, leading with whatever needs action.',
    'Charts are rendered directly below your message, so reference them naturally but do not restate every figure.',
    'Keep it under ~120 words. No headings, no sign-off.',
    '',
    'Facts:',
    facts,
  ].join('\n');
}

function buildFallbackText(results: InsightResult[]): string {
  const lines = results
    .filter((r) => r.status === 'ok' || r.status === 'partial')
    .map((r) => `• ${r.summary}`);
  return lines.length
    ? `Here's your scheduled business snapshot:\n${lines.join('\n')}`
    : 'Your scheduled business analysis ran, but there was not enough recent data to report yet.';
}
