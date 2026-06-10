import { randomUUID } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { RequestContext } from '@mastra/core/request-context';
import { generalAgent } from '../../../agents/general-agent';
import { extractModelIdentity } from '../../../integrations/portkey/model-config';
import { llmModelLabel } from '../../../models/llm-providers';
import { TENANT_MASTER_ID_KEY } from '../../../integrations/shared/marketplace-auth';
import { resolveAgentTextFromResult } from '../../../integrations/shared/agent-result-text';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

/**
 * Per-user chat sessions for the web app. These wrap Mastra Memory but enforce OUR scoping model
 * (private per user within a tenant) — which the built-in /api/memory routes don't know about:
 *   - resource = tenant (matches what the agent stream is forced to server-side)
 *   - each web thread carries metadata { channel: 'web', userId } and id `web:<tenant>:<user>:<uuid>`
 *   - every read verifies the thread belongs to BOTH the caller's tenant AND user.
 * Discord/active-mode threads (channel != 'web') therefore never surface here.
 */

type Mem = NonNullable<Awaited<ReturnType<typeof generalAgent.getMemory>>>;
type ChatContext = OpenApiHandlerContext & {
  req: { param: (name: string) => string | undefined; query: (name: string) => string | undefined };
};

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const WEB_THREAD_META = { channel: 'web' as const };

/** Resolve the authenticated tenant + end-user. Chat is user-scoped, so a user token is required. */
async function requireUser(c: OpenApiHandlerContext): Promise<{ tenantId: string; userId: string } | Response> {
  const auth = await resolveTenantFromBearer(c);
  if (auth instanceof Response) return auth;
  if (!auth.authUserId) {
    return openApiJsonError(c, 403, 'forbidden', 'Chat sessions require an authenticated user token.');
  }
  return { tenantId: auth.tenantId, userId: auth.authUserId };
}

async function getMemory(c: OpenApiHandlerContext): Promise<Mem | Response> {
  const memory = await generalAgent.getMemory();
  if (!memory) return openApiJsonError(c, 503, 'memory_unavailable', 'Agent memory is not configured.');
  return memory;
}

/** Returns the thread iff it belongs to this tenant AND user; otherwise null (callers 404). */
async function ownedThread(memory: Mem, threadId: string, tenantId: string, userId: string) {
  const thread = await memory.getThreadById({ threadId }).catch(() => null);
  if (!thread || thread.resourceId !== tenantId) return null;
  const meta = (thread.metadata ?? {}) as { channel?: string; userId?: string };
  if (meta.channel !== 'web' || meta.userId !== userId) return null;
  return thread;
}

function threadDTO(t: { id: string; title?: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: t.id,
    title: t.title ?? 'New chat',
    createdAt: new Date(t.createdAt).toISOString(),
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
}

/**
 * "Provider · model" label for an assistant message, from Mastra's stored `content.metadata.modelId`
 * (e.g. `@{slug}/{segment}`). Reuses the same parsing as the live stream so labels match.
 */
function messageModelLabel(content: unknown): string | undefined {
  const meta = (content as { metadata?: { modelId?: unknown } } | null)?.metadata;
  const modelId = meta && typeof meta.modelId === 'string' ? meta.modelId.trim() : '';
  if (!modelId) return undefined;
  const identity = extractModelIdentity(modelId);
  return identity ? llmModelLabel(identity) : undefined;
}

/** Normalize an LLM-generated title: single line, no surrounding quotes/trailing punctuation, capped. */
function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'`\s]+/, '')
    .replace(/["'`\s.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Flatten a stored message's content parts to plain display text. */
function messageText(content: unknown): string {
  const c = content as { parts?: Array<{ type?: string; text?: string }>; content?: string };
  const fromParts = (c?.parts ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (fromParts) return fromParts;
  return typeof c?.content === 'string' ? c.content.trim() : '';
}

/** Defense-in-depth: keep only this tenant+user's web threads, even if the store ignores the metadata filter. */
function isOwnedWebThread(t: { resourceId: string; metadata?: Record<string, unknown> }, tenantId: string, userId: string): boolean {
  const meta = (t.metadata ?? {}) as { channel?: string; userId?: string };
  return t.resourceId === tenantId && meta.channel === 'web' && meta.userId === userId;
}

/** GET /svc/v1/chat/threads — list the current user's web chat sessions (most-recent first). */
const listThreadsRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List the current user's chat sessions",
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Chat sessions' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const perPage = Math.min(Math.max(Number(c.req.query('perPage')) || 50, 1), 100);
    const page = Math.max(Number(c.req.query('page')) || 0, 0);
    const { threads } = await memory.listThreads({
      filter: { resourceId: who.tenantId, metadata: { ...WEB_THREAD_META, userId: who.userId } },
      orderBy: { field: 'updatedAt', direction: 'DESC' },
      perPage,
      page,
    });
    const mine = threads.filter((t) => isOwnedWebThread(t, who.tenantId, who.userId));
    return c.json({ threads: mine.map(threadDTO) });
  },
});

/** POST /svc/v1/chat/threads — create a new session (pre-created so the stream just appends). */
const createThreadRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Create a new chat session',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Created session' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const body = (await c.req.json<{ title?: string }>().catch(() => ({}))) as { title?: string };
    const title = (body.title ?? '').trim().slice(0, 120) || 'New chat';
    const threadId = `web:${who.tenantId}:${who.userId}:${randomUUID()}`;
    const now = new Date();
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId: who.tenantId,
        title,
        metadata: { ...WEB_THREAD_META, userId: who.userId },
        createdAt: now,
        updatedAt: now,
      },
    });
    return c.json(threadDTO({ id: threadId, title, createdAt: now, updatedAt: now }));
  },
});

/**
 * GET /svc/v1/chat/threads/:id/messages?before=<ISO>&limit=30
 * Newest-page-first infinite scroll: returns up to `limit` messages older than `before`
 * (or the newest `limit` when omitted), ordered ASC by createdAt for display.
 */
const listMessagesRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads/:id/messages`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'List messages in a chat session (paginated, newest-first)',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Messages page' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const threadId = c.req.param('id');
    if (!threadId) return openApiJsonError(c, 404, 'not_found', 'Chat session not found.');

    // The shared per-tenant "Notifications" thread is readable by ANY user of that tenant (it has
    // no per-user metadata). It's tenant-scoped by the tenantId embedded in the id, so a user of
    // another tenant can't reach it. It may not exist until the first notification → return empty.
    const isNotifications = threadId === `web:${who.tenantId}:notifications`;
    if (isNotifications) {
      const exists = await memory.getThreadById({ threadId }).catch(() => null);
      if (!exists) return c.json({ messages: [], hasMore: false, nextBefore: null });
    } else if (!(await ownedThread(memory, threadId, who.tenantId, who.userId))) {
      return openApiJsonError(c, 404, 'not_found', 'Chat session not found.');
    }

    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 100);
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? new Date(beforeRaw) : null;

    const result = await memory.recall({
      threadId,
      resourceId: who.tenantId,
      perPage: limit,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
      ...(before && !Number.isNaN(before.getTime())
        ? { filter: { dateRange: { end: before, endExclusive: true } } }
        : {}),
    });

    const ordered = [...result.messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const messages = ordered
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: messageText(m.content),
        createdAt: new Date(m.createdAt).toISOString(),
        // The provider+model that produced this answer, served from Mastra's stored message metadata
        // so the label shows on reload and on any device (not just the live stream).
        model: m.role === 'assistant' ? messageModelLabel(m.content) : undefined,
      }))
      .filter((m) => m.content.length > 0);

    return c.json({
      messages,
      hasMore: result.hasMore,
      nextBefore: ordered.length ? new Date(ordered[0].createdAt).toISOString() : null,
    });
  },
});

/** PATCH /svc/v1/chat/threads/:id — rename a session. */
const renameThreadRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads/:id`, {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Rename a chat session',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Updated session' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const threadId = c.req.param('id');
    const existing = threadId ? await ownedThread(memory, threadId, who.tenantId, who.userId) : null;
    if (!existing) return openApiJsonError(c, 404, 'not_found', 'Chat session not found.');

    const body = (await c.req.json<{ title?: string }>().catch(() => ({}))) as { title?: string };
    const title = (body.title ?? '').trim().slice(0, 120);
    if (!title) return openApiJsonError(c, 400, 'bad_request', 'A non-empty title is required.');

    const updatedAt = new Date();
    await memory.saveThread({ thread: { ...existing, title, updatedAt } });
    return c.json(threadDTO({ ...existing, title, updatedAt }));
  },
});

/** DELETE /svc/v1/chat/threads/:id — delete a session and its messages. */
const deleteThreadRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads/:id`, {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Delete a chat session',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const threadId = c.req.param('id');
    if (!threadId || !(await ownedThread(memory, threadId, who.tenantId, who.userId))) {
      return openApiJsonError(c, 404, 'not_found', 'Chat session not found.');
    }
    await memory.deleteThread(threadId);
    return c.json({ success: true });
  },
});

/**
 * POST /svc/v1/chat/threads/:id/title — generate a short, Claude-style title from the opening of the
 * conversation. Reuses the tenant's own LLM (via generalAgent) with a pinned small model and NO memory
 * binding (so the title prompt never lands in the conversation). Idempotent: returns the thread either
 * way; on any failure it keeps the existing title.
 */
const generateTitleRoute = registerApiRoute(`${OPEN_API_PREFIX}/chat/threads/:id/title`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Generate a short title for a chat session from its first exchange',
    tags: [...OPENAPI_TAGS.root],
    parameters: [authHeaderParam],
    responses: { 200: { description: 'Updated session' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ChatContext) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const memory = await getMemory(c);
    if (memory instanceof Response) return memory;

    const threadId = c.req.param('id');
    const thread = threadId ? await ownedThread(memory, threadId, who.tenantId, who.userId) : null;
    if (!thread) return openApiJsonError(c, 404, 'not_found', 'Chat session not found.');

    // Oldest-first opening of the conversation (a few messages is enough for a title).
    const recalled = await memory.recall({
      threadId: thread.id,
      resourceId: who.tenantId,
      perPage: 6,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    const opening = recalled.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, 4)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${messageText(m.content)}`)
      .filter((l) => l.length > 6)
      .join('\n')
      .slice(0, 2000);
    if (!opening) return c.json(threadDTO(thread)); // nothing to summarize yet

    // Pinned small model; no memory option → stateless (does not write to the thread).
    const requestContext = new RequestContext();
    requestContext.set(TENANT_MASTER_ID_KEY, who.tenantId);
    requestContext.set('channel', 'web');
    requestContext.set('groqModel', 'llama-3.1-8b-instant');

    const prompt =
      `Create a very short title (3-6 words, Title Case, no quotes, no trailing punctuation) for this ` +
      `conversation. Reply with ONLY the title.\n\n${opening}`;

    let title = '';
    try {
      const answer = await generalAgent.generate(prompt, { requestContext, maxSteps: 1 });
      title = sanitizeTitle(
        resolveAgentTextFromResult(answer as { text?: unknown; tripwire?: { reason?: unknown } }),
      );
    } catch {
      return c.json(threadDTO(thread)); // keep existing title on failure
    }
    if (!title) return c.json(threadDTO(thread));

    const updatedAt = new Date();
    await memory.saveThread({ thread: { ...thread, title, updatedAt } });
    return c.json(threadDTO({ ...thread, title, updatedAt }));
  },
});

export const chatHistoryRoutes = [
  listThreadsRoute,
  createThreadRoute,
  listMessagesRoute,
  renameThreadRoute,
  deleteThreadRoute,
  generateTitleRoute,
];
