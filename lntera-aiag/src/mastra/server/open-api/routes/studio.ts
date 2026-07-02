import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import {
  createTenantProject,
  deleteTenantProject,
  getTenantProject,
  listTenantProjects,
} from '../../../integrations/shared/tenant-projects';
import { PROJECT_KINDS } from '../../../integrations/shared/types';
import { OPEN_API_PREFIX } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

type StudioContext = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token | service JWT>' },
};

const createProjectBody = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(PROJECT_KINDS),
  })
  .strict();

/** GET /svc/v1/studio/projects — list the current tenant's Studio projects. */
export const studioListProjectsRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List the current tenant's Studio projects",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ projects }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const projects = await listTenantProjects(auth.tenantId);
    return c.json({ projects });
  },
});

/** POST /svc/v1/studio/projects — create a draft project ({ name, kind }). */
export const studioCreateProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Create a Studio project (draft)',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: {
      200: { description: '{ project }' },
      400: { description: 'Invalid body' },
      401: { description: 'Unauthorized' },
    },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return openApiJsonError(c, 400, 'invalid_request', 'Expected JSON body.');
    }
    let body;
    try {
      body = createProjectBody.parse(raw);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    try {
      const project = await createTenantProject({
        tenant_id: auth.tenantId,
        name: body.name,
        kind: body.kind,
      });
      return c.json({ project });
    } catch (err) {
      return openApiJsonError(
        c,
        400,
        'create_failed',
        err instanceof Error ? err.message : 'Failed to create project.',
      );
    }
  },
});

/** GET /svc/v1/studio/projects/:id — fetch one project (tenant-scoped). */
export const studioGetProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Get one Studio project',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ project }' }, 404: { description: 'Not found' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');
    return c.json({ project });
  },
});

/** DELETE /svc/v1/studio/projects/:id — remove a project row (tenant-scoped). */
export const studioDeleteProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id`, {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Delete a Studio project',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ ok }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const id = c.req.param('id') ?? '';
    const removed = await deleteTenantProject(auth.tenantId, id);
    return c.json({ ok: removed });
  },
});

export const studioRoutes = [
  studioListProjectsRoute,
  studioCreateProjectRoute,
  studioGetProjectRoute,
  studioDeleteProjectRoute,
];
