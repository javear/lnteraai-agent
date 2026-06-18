// REST for the "automatic business insights" settings UI. GET the schedule + available insights,
// PUT to update it, POST run-now to trigger an immediate analysis (fire-and-forget; the result lands
// in the Notifications chat / realtime). Tenant-scoped via the same bearer auth as the other routes.
import { registerApiRoute } from '@mastra/core/server';
import { logErrorBrief } from '../../../logger/compact-error';
import {
  ensureDefaultInsightSchedule,
  getInsightSchedule,
  nextRunFor,
  setInsightSchedule,
  type InsightSchedulePatch,
  type ResolvedInsightSchedule,
} from '../../../integrations/shared/insight-schedule-prefs';
import { armNextRun, cancelTenantRuns } from '../../../inngest/arm-insight';
import { listProviders } from '../../../insights/providers';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/** Serialize "when does this next fire" for the UI (firesToday=false ⇒ a later day). */
function nextRunPayload(schedule: ResolvedInsightSchedule | null) {
  if (!schedule) return { at: null, firesToday: false };
  const next = nextRunFor(schedule, new Date());
  return { at: next.at ? next.at.toISOString() : null, firesToday: next.firesToday };
}

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const getScheduleRoute = registerApiRoute(`${OPEN_API_PREFIX}/insights/schedule`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get the tenant automatic-insights schedule + available insights',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    // Lazily provision a load-balanced default schedule for brand-new tenants (idempotent).
    const schedule = await ensureDefaultInsightSchedule(auth.tenantId).catch(() => null);
    return c.json({ schedule, availableInsights: listProviders(), nextRun: nextRunPayload(schedule) });
  },
});

const putScheduleRoute = registerApiRoute(`${OPEN_API_PREFIX}/insights/schedule`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Update the tenant automatic-insights schedule',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Saved' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const body = (await c.req
      .json<{
        enabled?: boolean;
        localTime?: string;
        daysOfWeek?: number[];
        timezone?: string | null;
        subscribedKeys?: string[] | null;
      }>()
      .catch(() => ({}))) as {
      enabled?: boolean;
      localTime?: string;
      daysOfWeek?: number[];
      timezone?: string | null;
      subscribedKeys?: string[] | null;
    };

    const patch: InsightSchedulePatch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.localTime === 'string') patch.localTime = body.localTime;
    if (Array.isArray(body.daysOfWeek)) {
      patch.daysOfWeek = body.daysOfWeek.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    }
    if (body.timezone === null || typeof body.timezone === 'string') patch.timezone = body.timezone;
    if (body.subscribedKeys === null || Array.isArray(body.subscribedKeys)) {
      patch.subscribedKeys = body.subscribedKeys ?? null;
    }

    const schedule = await setInsightSchedule(auth.tenantId, patch);
    await cancelTenantRuns(auth.tenantId); // drop the superseded pending run, then schedule the new one
    await armNextRun(auth.tenantId, schedule);
    return c.json({ schedule, nextRun: nextRunPayload(schedule) });
  },
});

const runNowRoute = registerApiRoute(`${OPEN_API_PREFIX}/insights/run-now`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Run the tenant business analysis now (async)',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Accepted' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const tenantId = auth.tenantId;

    void (async () => {
      try {
        const schedule = await getInsightSchedule(tenantId);
        const { runAndNotifyInsights } = await import('../../../active-mode/insight-notifier');
        await runAndNotifyInsights(tenantId, schedule?.subscribedKeys ?? null);
      } catch (err) {
        logErrorBrief(`[insights] run-now failed tenant=${tenantId}`, err);
      }
    })();

    return c.json({
      ok: true,
      accepted: true,
      message: "Analyzing your business… results will appear in your Active Agent chat shortly.",
    });
  },
});

export const insightScheduleRoutes = [getScheduleRoute, putScheduleRoute, runNowRoute];
