// Turn computed insight results into an Active-Agent message: the engine produced exact numbers +
// charts; here the LLM only NARRATES the deterministic facts (no fabricated figures), then we deliver
// text + charts into the tenant's Notifications chat. A deterministic fallback guarantees delivery
// even if the LLM is empty/rate-limited. Used by the Inngest scheduled run AND the run-now tool.
import { RequestContext } from '@mastra/core/request-context';
import { notificationAgent } from '../agents/notification-agent';
import { stripReasoning } from '../integrations/shared/strip-reasoning';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import { logErrorBrief } from '../logger/compact-error';
import { AGENT_MODE_KEY, type AgentMode } from './notifier';
import { deliverTenantWebNotification } from './web-delivery';
import { runTenantInsights, type RunInsightsResult } from '../insights/engine';
import type { ChartSpec, InsightResult } from '../insights/types';

const INSIGHT_CONTEXT_KEY = 'insight';
const MAX_CHARTS = 6;

/** Delays (ms) BEFORE retry attempts 2, 3, … — short so a delivered insight stays timely. */
const NARRATE_RETRY_BACKOFF_MS = [2000, 6000, 12000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How many narration attempts before settling for the deterministic fallback (env-tunable, 1–6). */
function narrateMaxAttempts(): number {
  const n = Number(process.env.INSIGHT_NARRATE_MAX_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 3;
}

/** Transient = worth waiting out (provider spike / 429 / 5xx / timeout); permanent → fall back now. */
function isTransientLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /unavailable|high demand|temporar|overload|server error|try again|rate.?limit|too many requests|quota|timeout|timed out|econnreset|etimedout|fetch failed|\b(429|500|502|503|504)\b/.test(
    msg,
  );
}

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

  // Narrate with bounded retry. Each generate() already rolls across every connected model/provider
  // (the Portkey model chain), so a thrown error means they were ALL unavailable at once. For a
  // transient spike (Gemini "high demand", 429/5xx, timeout) we wait briefly and try again before
  // settling for the deterministic fallback — a temporary blip shouldn't downgrade the user to plain
  // text. Permanent errors (no LLM key, regex gate) skip the retries and fall back immediately.
  const answerText = await narrateInsights(facts, requestContext, tenantId);
  const usedFallback = !answerText.trim();

  await deliverTenantWebNotification({
    tenantId,
    text: usedFallback ? buildFallbackText(run.results) : answerText,
    heading: 'Business insights',
    kind: 'insight',
    charts: charts.length ? charts : undefined,
    deterministic: false,
    discord: true, // mirror the marketplace/connection notifications to Discord when linked
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

/**
 * Narrate the facts, retrying on TRANSIENT LLM errors (provider spikes/rate-limits) with backoff.
 * Returns the narrative, or '' when the LLM is unavailable/gated after all attempts — the caller then
 * delivers the deterministic fallback so the scheduled analysis is still delivered no matter what.
 */
async function narrateInsights(facts: string, requestContext: RequestContext, tenantId: string): Promise<string> {
  const maxAttempts = narrateMaxAttempts();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const answer = (await notificationAgent.generate(buildInsightPrompt(facts), { requestContext, maxSteps: 1 })) as {
        text?: unknown;
        tripwire?: unknown;
      };
      // A tripwire (no LLM key, regex guard) is permanent — fall back now rather than burn retries.
      if (answer.tripwire) return '';
      if (typeof answer.text === 'string' && stripReasoning(answer.text).trim())
        return stripReasoning(answer.text).trim();
      return ''; // empty (non-error) response → deterministic fallback
    } catch (err) {
      lastErr = err;
      if (!isTransientLlmError(err) || attempt === maxAttempts) break;
      const delay = NARRATE_RETRY_BACKOFF_MS[attempt - 1] ?? NARRATE_RETRY_BACKOFF_MS.at(-1) ?? 6000;
      logErrorBrief(
        `[active] insight narrate attempt ${attempt}/${maxAttempts} hit a transient LLM error; retrying in ${delay}ms tenant=${tenantId}`,
        err,
      );
      await sleep(delay);
    }
  }
  if (lastErr) {
    logErrorBrief(`[active] insight narrate failed after ${maxAttempts} attempt(s) tenant=${tenantId}`, lastErr);
  }
  return '';
}

function buildFallbackText(results: InsightResult[]): string {
  const lines = results
    .filter((r) => r.status === 'ok' || r.status === 'partial')
    .map((r) => `• ${r.summary}`);
  return lines.length
    ? `Here's your scheduled business snapshot:\n${lines.join('\n')}`
    : 'Your scheduled business analysis ran, but there was not enough recent data to report yet.';
}
