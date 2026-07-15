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
import {
  listTenantProjectSecrets,
  resolveTenantProjectSecretValues,
  upsertTenantProjectSecret,
} from '../../../integrations/shared/tenant-project-secrets';
import { getGithubConfig, signGitProxyToken, verifyGitProxyToken } from '../../../integrations/studio/config';
import { createGithubRepo, deleteGithubRepoBestEffort, gitBasicAuthHeader, repoNameFor } from '../../../integrations/studio/github';
import { deployToEdgeOne, setEdgeOneEnvVars } from '../../../integrations/studio/edgeone';
import { getStudioBridge } from '../../../integrations/studio/browser-bridge';
import { seedProjectTemplate } from '../../../integrations/studio/template-seed';
import type { StudioResultEnvelope } from '../../../integrations/studio/protocol';
import { logErrorBrief } from '../../../logger/compact-error';
import { technicalAgent } from '../../../agents/technical-agent';
import { extractModelIdentity } from '../../../integrations/portkey/model-config';
import { llmModelLabel } from '../../../models/llm-providers';
import { OPEN_API_PREFIX } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/** Clone-URL proxy tokens live ~7 days; a reconnect/init re-mints them. */
const GIT_PROXY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Flatten a stored message's content parts to plain display text — same shape chat-history.ts reads. */
function studioMessageText(content: unknown): string {
  const c = content as { parts?: Array<{ type?: string; text?: string }>; content?: string };
  const fromParts = (c?.parts ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (fromParts) return fromParts;
  return typeof c?.content === 'string' ? c.content.trim() : '';
}

/** "Provider · model" label from Mastra's stored `content.metadata.modelId`, same parsing as the live stream. */
function studioMessageModelLabel(content: unknown): string | undefined {
  const meta = (content as { metadata?: { modelId?: unknown } } | null)?.metadata;
  const modelId = meta && typeof meta.modelId === 'string' ? meta.modelId.trim() : '';
  if (!modelId) return undefined;
  const identity = extractModelIdentity(modelId);
  return identity ? llmModelLabel(identity) : undefined;
}

type StudioMessagesContext = StudioContext & { req: StudioContext['req'] & { query: (name: string) => string | undefined } };

/**
 * GET /svc/v1/studio/projects/:id/messages?before=<ISO>&limit=50 — the technical agent's stored
 * conversation for this project (newest-page-first, ASC for display), so reopening a project shows
 * its chat history instead of starting blank every time. Unlike the business chat's per-USER threads
 * (chat-history.ts), a Studio thread is per-PROJECT — ownership is exactly "does this project belong
 * to the caller's tenant" (already the check every other Studio route uses), and resourceId is always
 * the SERVER-resolved tenantId, never anything the caller could supply, so this can't leak another
 * tenant's thread even if project ids were guessable.
 */
export const studioMessagesRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/messages`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List a Studio project's chat history (paginated, newest-first)",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Messages page' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioMessagesContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    const memory = await technicalAgent.getMemory();
    if (!memory) return openApiJsonError(c, 503, 'memory_unavailable', 'Agent memory is not configured.');

    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? new Date(beforeRaw) : null;

    let result;
    try {
      result = await memory.recall({
        threadId: project.id,
        resourceId: auth.tenantId,
        perPage: limit,
        page: 0,
        orderBy: { field: 'createdAt', direction: 'DESC' },
        ...(before && !Number.isNaN(before.getTime())
          ? { filter: { dateRange: { end: before, endExclusive: true } } }
          : {}),
      });
    } catch (err) {
      // A brand-new project's thread doesn't exist until the agent's first turn creates it (Mastra
      // auto-creates threads lazily on first stream() call, never up front) — recall() throws rather
      // than returning empty for a thread it's never heard of. That's not a real error here, just
      // "no history yet."
      if (err instanceof Error && /no thread found/i.test(err.message)) {
        return c.json({ messages: [], hasMore: false, nextBefore: null });
      }
      throw err;
    }

    const ordered = [...result.messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const messages = ordered
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: studioMessageText(m.content),
        createdAt: new Date(m.createdAt).toISOString(),
        model: m.role === 'assistant' ? studioMessageModelLabel(m.content) : undefined,
      }))
      .filter((m) => m.content.length > 0);

    return c.json({
      messages,
      hasMore: result.hasMore,
      nextBefore: ordered.length ? new Date(ordered[0].createdAt).toISOString() : null,
    });
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
    // Best-effort — never blocks the tenant's own delete on a GitHub-side hiccup (already deleted,
    // permissions, etc.); repoNameFor is a pure function of the id, so no extra lookup is needed.
    if (removed) void deleteGithubRepoBestEffort(repoNameFor(id)).catch(() => undefined);
    return c.json({ ok: removed });
  },
});

/** POST /svc/v1/studio/projects/:id/init — create the GitHub repo; return a proxied clone URL. */
export const studioInitProjectRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/init`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Provision a project git repo (GitHub) and return a proxied clone URL',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ project, gitPath }' }, 400: { description: 'Not configured' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    if (!getGithubConfig()) return openApiJsonError(c, 400, 'not_configured', 'GitHub is not configured on the server.');

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    try {
      const repo = await createGithubRepo(repoNameFor(project.id));
      // Attempt the starter-template seed on EVERY init, not just first creation: seedProjectTemplate
      // is self-guarding (it no-ops unless the repo is still in GitHub's bare auto-init state), so this
      // can never clobber the tenant's own work — but it DOES self-heal a project whose first seed
      // attempt silently failed (e.g. a transient GitHub/proxy timeout), which previously left the
      // tenant with a permanently empty repo the technical agent's own instructions forbid scaffolding
      // into. Best-effort either way: a failure here still leaves a usable (if empty) repo.
      await seedProjectTemplate({ kind: project.kind, repoFullName: repo.fullName }).catch((err) => {
        logErrorBrief(`[studio] template seed failed (project=${project.id})`, err);
      });
      const updated = await updateTenantProject(auth.tenantId, project.id, { git_repo_url: repo.cloneUrl });
      const token = signGitProxyToken({ projectId: project.id, repo: repo.fullName, exp: Date.now() + GIT_PROXY_TTL_MS });
      // Return a PATH only. The browser prefixes its own origin (the whitelisted frontend, e.g.
      // lntera.ai) so the pod's git reaches an allow-listed domain; the frontend (Vercel) rewrites
      // /svc/v1/studio/git/* to this backend, which injects GitHub auth. BrowserPod blocks pod
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
      const projectName = repoNameFor(project.id);
      const { url } = await deployToEdgeOne({
        projectName,
        zipBase64: body.zipBase64,
        env: 'production',
      });
      // A web app's URL is its site; an MCP project's URL is its endpoint.
      const patch =
        project.kind === 'mcp'
          ? { mcp_url: url, status: 'deployed' as const }
          : { deploy_url: url, status: 'deployed' as const };
      const updated = await updateTenantProject(auth.tenantId, project.id, patch);
      // Best-effort: the deploy above already succeeded — a Vault hiccup resolving secrets (or
      // pushing them to EdgeOne) must not overwrite that with a false "deploy failed" below.
      const secretValues = await resolveTenantProjectSecretValues(project.id).catch(() => ({}) as Record<string, string>);
      await setEdgeOneEnvVars({ projectName, values: secretValues });
      return c.json({ project: updated, url });
    } catch (err) {
      await updateTenantProject(auth.tenantId, project.id, { status: 'error' }).catch(() => undefined);
      return openApiJsonError(c, 400, 'deploy_failed', err instanceof Error ? err.message : 'Deploy failed.');
    }
  },
});

const mcpCallBody = z
  .object({
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
    /** Which deployed environment to call — 'preview' (the agent's own, auto-updating deploy) or
     *  'production' (only ever set by the user's explicit Publish). Defaults to preview since that's
     *  what the tester panel targets before anything's been published. */
    target: z.enum(['preview', 'production']).optional(),
  })
  .strict();

/**
 * POST /svc/v1/studio/projects/:id/mcp-call — proxy ONE JSON-RPC call to the project's own deployed
 * MCP endpoint (preview or production), for the Studio "MCP Tester" panel. Proxied server-side (not
 * called from the browser) so no CORS support is required of the EdgeOne function. Not an open proxy:
 * the target URL is always a server-stored column (preview_url/mcp_url) of a project owned by the
 * authenticated tenant — never caller-supplied.
 */
export const studioMcpCallRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/mcp-call`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: "Proxy a JSON-RPC call to the project's deployed MCP endpoint (tester panel)",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ status, response }' }, 400: { description: 'Invalid/not deployed' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');
    if (project.kind !== 'mcp') return openApiJsonError(c, 400, 'wrong_kind', 'Only mcp projects have an MCP endpoint.');

    let body;
    try {
      body = mcpCallBody.parse(await c.req.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    const targetUrl = (body.target ?? 'preview') === 'production' ? project.mcp_url : project.preview_url;
    if (!targetUrl) {
      return openApiJsonError(
        c,
        400,
        'not_deployed',
        body.target === 'production'
          ? 'Publish the project first — there is no live production endpoint to test yet.'
          : "Nothing's deployed to preview yet — ask the agent to build something first.",
      );
    }

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: body.method, params: body.params ?? {} }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        response = { raw: text.slice(0, 4000) };
      }
      return c.json({ status: res.status, response });
    } catch (err) {
      return openApiJsonError(c, 400, 'mcp_call_failed', err instanceof Error ? err.message : 'MCP call failed.');
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

/** GET /svc/v1/studio/projects/:id/secrets — list a project's configured secrets (names/descriptions
 *  only, never values) for the "configured secrets" UI. */
export const studioListSecretsRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/secrets`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List a project's configured secret names (no values)",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ secrets }' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    const rows = await listTenantProjectSecrets(project.id);
    return c.json({
      secrets: rows.map((r) => ({ name: r.name, description: r.description, created_at: r.created_at })),
    });
  },
});

const upsertSecretBody = z
  .object({
    name: z.string().min(1).max(100),
    value: z.string().min(1),
    description: z.string().max(500).optional(),
  })
  .strict();

/** POST /svc/v1/studio/projects/:id/secrets — register (or update) a tenant-supplied secret for this
 *  project. Only the name/description round-trip back — the value goes straight into Vault. */
export const studioUpsertSecretRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/secrets`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Register or update a secret for this project',
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ name, description }' }, 400: { description: 'Invalid body' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    let body;
    try {
      body = upsertSecretBody.parse(await c.req.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    let saved;
    try {
      saved = await upsertTenantProjectSecret(project.id, body);
    } catch (err) {
      return openApiJsonError(c, 400, 'save_failed', err instanceof Error ? err.message : 'Could not save the secret.');
    }

    // Push it to the ALREADY-DEPLOYED EdgeOne function too, not just Vault + the browser's dev
    // sandbox (the only other delivery path — see BrowserPodProvider.setEnv, wired from
    // refreshSecretEnv() in Studio.tsx). Without this, submitting a secret after a project has already
    // been deployed does nothing for it: an "mcp" project has no dev server at all (the deployed
    // function IS the only real runtime, reached via the MCP Tester / studio-deploy-preview's own URL),
    // so the secret silently never reaches the code that needs it until the agent happens to redeploy
    // again — confirmed in production ("Tavily API key is not set" after the user had already set it).
    // Best-effort: the secret is already saved in Vault either way; a push failure here just means this
    // specific deployment doesn't see it yet, same as any other setEdgeOneEnvVars call in this codebase.
    if (project.mcp_url || project.preview_url) {
      const projectName = repoNameFor(project.id);
      const secretValues = await resolveTenantProjectSecretValues(project.id).catch(() => ({}) as Record<string, string>);
      await setEdgeOneEnvVars({ projectName, values: secretValues }).catch((err) =>
        logErrorBrief(`[studio] failed to push secret to deployed EdgeOne project=${projectName}`, err),
      );
    }

    return c.json({ name: saved.name, description: saved.description });
  },
});

/**
 * GET /svc/v1/studio/projects/:id/secrets/values — resolve every configured secret to its plaintext
 * value. The ONE point where a secret's plaintext leaves the backend: the tenant's own authenticated
 * browser tab, to inject into their own project's dev sandbox (see BrowserPodProvider.setEnv). Never
 * logged, never cached server-side beyond this request.
 */
export const studioSecretValuesRoute = registerApiRoute(`${OPEN_API_PREFIX}/studio/projects/:id/secrets/values`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "Resolve a project's secrets to their plaintext values (for the dev sandbox)",
    tags: ['Studio'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ values }' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: StudioContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const project = await getTenantProject(auth.tenantId, id);
    if (!project) return openApiJsonError(c, 404, 'not_found', 'Project not found.');

    const values = await resolveTenantProjectSecretValues(project.id);
    return c.json({ values });
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
          // Returns whether the write actually succeeded — a failed enqueue means the connection is
          // dead. Relying on `cancel()`/the abort signal ALONE to detect that isn't safe: in practice
          // those don't fire reliably for every disconnect path, which is exactly how a Studio tenant
          // can silently pile up dead entries until `registerStream`'s per-tenant cap permanently
          // 429s every future attempt (nothing ever frees the stale slots). A failed write is the
          // one signal that can't lie — self-heals within one heartbeat interval regardless of why
          // the higher-level disconnect notifications didn't fire.
          const write = (chunk: string): boolean => {
            try {
              controller.enqueue(encoder.encode(chunk));
              return true;
            } catch {
              return false;
            }
          };
          unregister = getStudioBridge().registerStream(auth.tenantId, sessionId, write);
          write(': connected\n\n');
          // Keeps the connection alive through idle-timeout proxies; also doubles as a liveness check.
          heartbeat = setInterval(() => {
            if (!write(': ping\n\n')) cleanup();
          }, 20_000);
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
 * repo-scoped token and forward to github.com with the server's credentials injected — so the
 * tenant's git works without ever seeing our GitHub token. Registered for GET (info/refs) and POST
 * (upload-pack / receive-pack). Git-over-HTTPS auth is HTTP Basic (token as password) — a DIFFERENT
 * scheme from the REST API's Bearer header (see github.ts's gitBasicAuthHeader).
 */
async function gitProxyHandler(c: GitProxyContext): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const claim = verifyGitProxyToken(token);
  if (!claim) return openApiJsonError(c, 401, 'invalid_token', 'Invalid or expired git token.');
  const cfg = getGithubConfig();
  if (!cfg) return openApiJsonError(c, 400, 'not_configured', 'GitHub is not configured.');

  const url = new URL(c.req.url);
  const marker = `/studio/git/${token}/git`;
  const rest = url.pathname.slice(url.pathname.indexOf(marker) + marker.length); // e.g. "/info/refs"
  const target = `https://github.com/${claim.repo}.git${rest}${url.search}`;

  const fwd = new Headers();
  for (const h of ['content-type', 'accept', 'git-protocol', 'user-agent']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('Authorization', gitBasicAuthHeader(cfg.token));

  const init: RequestInit & { duplex?: 'half' } = {
    method: c.req.method,
    headers: fwd,
  };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(target, init);
  if (upstream.status === 401 || upstream.status === 403) {
    // Distinguishes "GitHub itself rejected the server's own PAT" from our own token check above
    // (verifyGitProxyToken already logs its own rejections) — from the browser's side, both failure
    // modes look identical (isomorphic-git's generic "HTTP Error: 401"), which cost real diagnostic
    // time in production before this log line existed.
    console.warn(`[studio] git-proxy upstream rejected repo=${claim.repo} method=${c.req.method} path=${rest} status=${upstream.status}`);
  }
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
  studioMessagesRoute,
  studioInitProjectRoute,
  studioDeployProjectRoute,
  studioConnectProjectRoute,
  studioListSecretsRoute,
  studioUpsertSecretRoute,
  studioSecretValuesRoute,
  studioMcpCallRoute,
  studioCommandStreamRoute,
  studioCommandResultRoute,
  studioGitProxyGetRoute,
  studioGitProxyPostRoute,
  studioDeleteProjectRoute,
];
