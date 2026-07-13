import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { OPEN_API_PREFIX } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';
import {
  listResearchReports,
  getResearchReport,
  setResearchReportSharing,
  getPublicResearchReport,
} from '../../../integrations/research/reports-repo';
import { ensureResearchDiscussThread } from '../../../integrations/research/discuss-thread';

type ParamCtx = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token | service JWT>' },
};

const shareBody = z.object({ isPublic: z.boolean() }).strict();

/** GET /svc/v1/research/reports — list the tenant's research reports (no content, for a list view). */
export const researchListReportsRoute = registerApiRoute(`${OPEN_API_PREFIX}/research/reports`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List the tenant's research reports",
    tags: ['Research'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ reports }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const reports = await listResearchReports(auth.tenantId);
    return c.json({ reports });
  },
});

/** GET /svc/v1/research/reports/:id — one report's full content (tenant-owned only). */
export const researchGetReportRoute = registerApiRoute(`${OPEN_API_PREFIX}/research/reports/:id`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get a research report',
    tags: ['Research'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ report }' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ParamCtx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const id = c.req.param('id') ?? '';
    const report = await getResearchReport(auth.tenantId, id);
    if (!report) return openApiJsonError(c, 404, 'not_found', 'Report not found.');
    return c.json({ report });
  },
});

/** POST /svc/v1/research/reports/:id/share — toggle public sharing ({ isPublic }); turning ON (re)generates a slug. */
export const researchShareReportRoute = registerApiRoute(`${OPEN_API_PREFIX}/research/reports/:id/share`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Toggle public sharing for a research report',
    tags: ['Research'],
    parameters: [authHeaderParam],
    responses: {
      200: { description: '{ report }' },
      400: { description: 'Invalid body' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  },
  handler: async (c: ParamCtx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    let body;
    try {
      body = shareBody.parse(await c.req.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    const id = c.req.param('id') ?? '';
    const report = await setResearchReportSharing(auth.tenantId, id, body.isPublic);
    if (!report) return openApiJsonError(c, 404, 'not_found', 'Report not found.');
    return c.json({ report });
  },
});

/** POST /svc/v1/research/reports/:id/discuss — ensures (and returns) the report's dedicated follow-up
 *  chat thread, seeded with the report's content on first call. */
export const researchDiscussReportRoute = registerApiRoute(`${OPEN_API_PREFIX}/research/reports/:id/discuss`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Start (or resume) the follow-up chat thread for a research report',
    tags: ['Research'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ threadId }' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ParamCtx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const id = c.req.param('id') ?? '';
    const report = await getResearchReport(auth.tenantId, id);
    if (!report) return openApiJsonError(c, 404, 'not_found', 'Report not found.');
    const threadId = await ensureResearchDiscussThread(auth.tenantId, report);
    return c.json({ threadId });
  },
});

/** GET /svc/v1/research/public/:slug — the PUBLIC read path. No tenant auth — the slug (unguessable,
 *  revocable) IS the access control for this intentionally-public surface. */
export const researchPublicReportRoute = registerApiRoute(`${OPEN_API_PREFIX}/research/public/:slug`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get a publicly-shared research report by its share slug (no auth)',
    tags: ['Research'],
    responses: { 200: { description: '{ report }' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ParamCtx) => {
    const slug = c.req.param('slug') ?? '';
    const report = await getPublicResearchReport(slug);
    if (!report) return openApiJsonError(c, 404, 'not_found', 'Report not found.');
    // Strip fields an anonymous viewer has no business seeing (the owning tenant's id, the sharing
    // slug itself, internal error detail) — only the report's own content is meant to be public here.
    const { tenantId: _tenantId, publicSlug: _publicSlug, errorMessage: _errorMessage, ...publicFields } = report;
    return c.json({ report: publicFields });
  },
});

export const researchRoutes = [
  researchListReportsRoute,
  researchGetReportRoute,
  researchShareReportRoute,
  researchDiscussReportRoute,
  researchPublicReportRoute,
];
