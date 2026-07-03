import { randomBytes } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import {
  createTenantProject,
  deleteTenantProject,
  getTenantProject,
  listTenantProjects,
  updateTenantProject,
} from '../../../integrations/shared/tenant-projects';
import { PROJECT_KINDS } from '../../../integrations/shared/types';
import { createIntegrationVaultSecret } from '../../../integrations/shared/vault';
import { getGiteaConfig, signGitProxyToken, verifyGitProxyToken } from '../../../integrations/studio/config';
import { createGiteaRepo } from '../../../integrations/studio/gitea';
import { deployToEdgeOne } from '../../../integrations/studio/edgeone';
import { getStudioBridge } from '../../../integrations/studio/browser-bridge';
import type { StudioResultEnvelope } from '../../../integrations/studio/protocol';
import { OPEN_API_PREFIX } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/** Clone-URL proxy tokens live ~7 days; a reconnect/init re-mints them. */
const GIT_PROXY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Repo name is derived from the project id so it's unique + stable per project. */
function repoNameFor(projectId: string): string {
  return `studio-${projectId.slice(0, 8)}`;
}

type StudioContext = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

/** Git-proxy needs raw request access (url/method/body) that the narrow OpenAPI ctx type omits. */
type GitProxyContext = OpenApiHandlerContext & {
  req: {
    param: (name: string) => string | undefined;
    header: (name: string) => string | undefined;
    url: string;
    method: string;
    raw: Request;
  };
};

/** The command-stream route needs a query param reader and the raw Request (for its abort signal). */
type StudioStreamContext = OpenApiHandlerContext & {
  req: { query: (name: string) => string | undefined; raw: Request };
};

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

/** POST /svc/v1/studio/projects/:id/init — create the Gitea repo; return a proxied clone URL. */
export const studioInitProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/init`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Provision a project git repo (Gitea) and return a proxied clone URL',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ project, gitPath }' }, 400: { description: 'Not configured' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    if (!getGiteaConfig()) return openApiJsonError(c, 400, 'not_configured', 'Gitea is not configured on the server.');

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    try {
      const repo = await createGiteaRepo(repoNameFor(project.id));
      const updated = await updateTenantProject(auth.tenantId, project.id, { gitea_repo: repo.cloneUrl });
      const token = signGitProxyToken({ projectId: project.id, repo: repo.fullName, exp: Date.now() + GIT_PROXY_TTL_MS });
      // Return a PATH only. The browser prefixes its own origin (the whitelisted frontend, e.g.
      // lntera.ai) so the pod's git reaches an allow-listed domain; the frontend (Vercel) rewrites
      // /svc/v1/studio/git/* to this backend, which injects the Gitea token. BrowserPod blocks pod
      // egress to non-whitelisted domains, so the pod can't hit the backend host directly.
      const gitPath = `${OPEN_API_PREFIX}/studio/git/${token}/git`;
      return c.json({ project: updated, gitPath });
    } catch (err) {
      return openApiJsonError(c, 400, 'init_failed', err instanceof Error ? err.message : 'Init failed.');
    }
  },
});

const deployBody = z.object({ zipBase64: z.string().min(1) }).strict();

/** POST /svc/v1/studio/projects/:id/deploy — ship built artifacts to EdgeOne; store the URL. */
export const studioDeployProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/deploy`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Deploy built artifacts to EdgeOne Pages',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ project, url }' }, 400: { description: 'Invalid/not configured' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    let body;
    try {
      body = deployBody.parse(await c.req.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    try {
      const { url } = await deployToEdgeOne({ projectName: repoNameFor(project.id), zipBase64: body.zipBase64 });
      // A web app's URL is its site; an MCP project's URL is its endpoint.
      const patch =
        project.kind === 'mcp'
          ? { mcp_url: url, status: 'deployed' as const }
          : { deploy_url: url, status: 'deployed' as const };
      const updated = await updateTenantProject(auth.tenantId, project.id, patch);
      return c.json({ project: updated, url });
    } catch (err) {
      await updateTenantProject(auth.tenantId, project.id, { status: 'error' }).catch(() => undefined);
      return openApiJsonError(c, 400, 'deploy_failed', err instanceof Error ? err.message : 'Deploy failed.');
    }
  },
});

/** POST /svc/v1/studio/projects/:id/connect — attach a deployed MCP project to the business agent. */
export const studioConnectProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/connect`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Connect a deployed MCP project to the tenant business agent',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ project }' }, 400: { description: 'Invalid state' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');
    if (project.kind !== 'mcp' || !project.mcp_url) {
      return openApiJsonError(c, 400, 'not_deployable', 'Only a deployed MCP project can be connected.');
    }

    try {
      const authToken = randomBytes(24).toString('hex');
      const ref = await createIntegrationVaultSecret(`studio:mcp:${project.id}`, { authToken });
      const updated = await updateTenantProject(auth.tenantId, project.id, {
        mcp_secret_ref: ref,
        status: 'connected',
      });
      return c.json({ project: updated });
    } catch (err) {
      return openApiJsonError(c, 400, 'connect_failed', err instanceof Error ? err.message : 'Connect failed.');
    }
  },
});

/**
 * GET /svc/v1/studio/commands/stream — a long-lived Server-Sent-Events connection, one per Studio
 * browser session. The technical agent's Workspace tools (studio-write-file, studio-run-command, ...)
 * write directly into this stream via {@link getStudioBridge} — an in-process call, not a third-party
 * relay — which is what makes tool round-trips fast. Auth is the same bearer token as every other
 * Studio route; `sessionId` just selects WHICH of this tenant's open tabs receives the commands.
 */
export const studioCommandStreamRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/commands/stream`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Open the Studio command stream (SSE) for one browser session',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: {
      200: { description: 'text/event-stream' },
      400: { description: 'Missing sessionId' },
      401: { description: 'Unauthorized' },
    },
  },
  handler: async (c: StudioStreamContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return openApiJsonError(c, 400, 'invalid_request', 'sessionId is required.');

    const encoder = new TextEncoder();
    let unregister: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      unregister?.();
      unregister = null;
    };

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (chunk: string) => {
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              // controller already closed — the abort listener below still runs cleanup.
            }
          };
          unregister = getStudioBridge().registerStream(auth.tenantId, sessionId, write);
          write(': connected\n\n');
          // Keeps the connection alive through idle-timeout proxies; also doubles as a liveness signal.
          heartbeat = setInterval(() => write(': ping\n\n'), 20_000);
        },
        cancel: cleanup,
      });
    } catch (err) {
      // Thrown synchronously by registerStream (e.g. the per-tenant stream cap) before any bytes sent.
      return openApiJsonError(c, 429, 'too_many_streams', err instanceof Error ? err.message : String(err));
    }

    // Belt-and-suspenders: some runtimes don't reliably call ReadableStream#cancel on client
    // disconnect, but the request's AbortSignal always fires.
    c.req.raw.signal.addEventListener('abort', cleanup, { once: true });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});

const studioCommandResultBody = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sessionId: z.string().min(1), result: z.unknown() }),
  z.object({ ok: z.literal(false), sessionId: z.string().min(1), error: z.string() }),
]);

/**
 * POST /svc/v1/studio/commands/:cmdId/result — the browser's reply to one dispatched command.
 * `cmdId` comes from the URL (not trusted client JSON); the bridge itself re-checks that the posting
 * tenant and the pending call's session actually match before resolving anything.
 */
export const studioCommandResultRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/commands/:cmdId/result`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: "Post a Studio command's result back to the agent's pending call",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: {
      200: { description: '{ ok }' },
      400: { description: 'Invalid body' },
      401: { description: 'Unauthorized' },
    },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const cmdId = c.req.param('cmdId') ?? '';

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return openApiJsonError(c, 400, 'invalid_request', 'Expected JSON body.');
    }
    const parsed = studioCommandResultBody.safeParse(raw);
    if (!parsed.success) {
      return openApiJsonError(c, 400, 'invalid_body', parsed.error.issues.map((i) => i.message).join('; '));
    }

    const envelope = (
      parsed.data.ok
        ? { cmdId, sessionId: parsed.data.sessionId, ok: true, result: parsed.data.result }
        : { cmdId, sessionId: parsed.data.sessionId, ok: false, error: parsed.data.error }
    ) as StudioResultEnvelope;
    getStudioBridge().resolveResult(auth.tenantId, envelope);
    return c.json({ ok: true });
  },
});

/**
 * Git smart-HTTP proxy. The browser pod clones/pushes to `…/studio/git/:token/git/…`; we verify the
 * repo-scoped token and forward to Gitea Cloud with the server's credentials injected — so the
 * tenant's git works without ever seeing our Gitea token. Registered for GET (info/refs) and POST
 * (upload-pack / receive-pack).
 */
async function gitProxyHandler(c: GitProxyContext): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const claim = verifyGitProxyToken(token);
  if (!claim) return openApiJsonError(c, 401, 'invalid_token', 'Invalid or expired git token.');
  const cfg = getGiteaConfig();
  if (!cfg) return openApiJsonError(c, 400, 'not_configured', 'Gitea is not configured.');

  const url = new URL(c.req.url);
  const marker = `/studio/git/${token}/git`;
  const rest = url.pathname.slice(url.pathname.indexOf(marker) + marker.length); // e.g. "/info/refs"
  const target = `${cfg.baseUrl}/${claim.repo}.git${rest}${url.search}`;

  const fwd = new Headers();
  for (const h of ['content-type', 'accept', 'git-protocol', 'user-agent']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('Authorization', `token ${cfg.token}`);

  const init: RequestInit & { duplex?: 'half' } = {
    method: c.req.method,
    headers: fwd,
  };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(target, init);
  const respHeaders = new Headers();
  for (const h of ['content-type', 'cache-control', 'expires', 'pragma']) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  // Permissive CORS: the pod's git may run this as a cross-origin fetch (its origin ≠ lntera.ai).
  respHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

export const studioGitProxyGetRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/git/:token/git/*`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Git smart-HTTP proxy (info/refs)', tags: ['Studio'], responses: { 200: { description: 'git' } } },
  handler: gitProxyHandler,
});
export const studioGitProxyPostRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/git/:token/git/*`, {
  method: 'POST',
  requiresAuth: false,
  openapi: { summary: 'Git smart-HTTP proxy (upload/receive-pack)', tags: ['Studio'], responses: { 200: { description: 'git' } } },
  handler: gitProxyHandler,
});

export const studioRoutes = [
  studioListProjectsRoute,
  studioCreateProjectRoute,
  studioGetProjectRoute,
  studioInitProjectRoute,
  studioDeployProjectRoute,
  studioConnectProjectRoute,
  studioCommandStreamRoute,
  studioCommandResultRoute,
  studioGitProxyGetRoute,
  studioGitProxyPostRoute,
  studioDeleteProjectRoute,
];
