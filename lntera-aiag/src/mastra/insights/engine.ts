// Run a tenant's subscribed insight providers: resolve connections, prefetch the minimum data once,
// then run each provider isolated (a thrown provider becomes an 'error' result, never aborting the
// run). Used by both the Inngest scheduled function and the on-demand "analyze now" tool.
import { listConnectionsByTenant } from '../integrations/shared/supabase';
import { prefetchTenantData } from './prefetch';
import { resolveSubscribedProviders } from './providers';
import type { InsightContext, InsightResult } from './types';

export interface RunInsightsResult {
  status: 'ok' | 'no_connection' | 'no_insights';
  results: InsightResult[];
  /** Non-fatal data-fetch errors (per shop) gathered during prefetch. */
  errors: string[];
}

export async function runTenantInsights(
  tenantId: string,
  subscribedKeys: string[] | null,
  now: Date = new Date(),
): Promise<RunInsightsResult> {
  const connections = await listConnectionsByTenant(tenantId);
  if (connections.length === 0) return { status: 'no_connection', results: [], errors: [] };

  const providers = resolveSubscribedProviders(subscribedKeys);
  if (providers.length === 0) return { status: 'no_insights', results: [], errors: [] };

  const needProducts = providers.some((p) => p.needs?.products);
  const needOrderItems = providers.some((p) => p.needs?.orderItems);
  const data = await prefetchTenantData(tenantId, { now, needProducts, needOrderItems });

  const ctx: InsightContext = { tenantId, now, data };
  const results: InsightResult[] = [];
  for (const provider of providers) {
    try {
      results.push(await provider.compute(ctx));
    } catch (err) {
      results.push({
        key: provider.key,
        label: provider.label,
        status: 'error',
        summary: `Could not compute ${provider.label}.`,
        metrics: {},
        dataCaveats: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return { status: 'ok', results, errors: data.errors };
}
