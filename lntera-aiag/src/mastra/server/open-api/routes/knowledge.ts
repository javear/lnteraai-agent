import { randomUUID } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { OPEN_API_PREFIX } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';
import {
  createKnowledgeDocument,
  deleteKnowledgeDocumentRow,
  deleteKnowledgeFile,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  storagePathFor,
  uploadKnowledgeFile,
} from '../../../integrations/knowledge/documents-repo';
import { checkQuota, getKnowledgeUsage, recordUsageDelta, touchActivity } from '../../../integrations/knowledge/quota';
import { deleteDocumentFromGraph } from '../../../integrations/knowledge/graph-write';
import { getTenantGraphSnapshot } from '../../../integrations/knowledge/graph-read';
import { ensureGraphFresh } from '../../../integrations/knowledge/eviction';
import { inngest } from '../../../inngest/client';

type ParamCtx = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token | service JWT>' },
};

// Base64 grows input ~4/3 — cap the RAW string length so we never decode an absurd payload into
// memory before the (much smaller) quota check gets to reject it. 14MB base64 ≈ ~10.5MB decoded,
// comfortably above the whole-tenant 10MB cap so a single valid upload is never blocked by this.
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;

const ALLOWED_EXTENSIONS = /\.(pdf|xlsx|xls|txt|md|csv)$/i;

const uploadBody = z
  .object({
    filename: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(200),
    fileBase64: z.string().min(1).max(MAX_BASE64_LENGTH),
  })
  .strict();

/** GET /svc/v1/knowledge/documents — list the tenant's knowledge documents + usage. */
export const knowledgeListDocumentsRoute = registerApiRoute(`${OPEN_API_PREFIX}/knowledge/documents`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "List the tenant's knowledge documents",
    tags: ['Knowledge'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ documents, usage }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const [documents, usage] = await Promise.all([
      listKnowledgeDocuments(auth.tenantId),
      getKnowledgeUsage(auth.tenantId),
    ]);
    return c.json({ documents, usage });
  },
});

/** POST /svc/v1/knowledge/documents — upload a document ({ filename, mimeType, fileBase64 }). */
export const knowledgeUploadDocumentRoute = registerApiRoute(`${OPEN_API_PREFIX}/knowledge/documents`, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Upload a knowledge document',
    tags: ['Knowledge'],
    parameters: [authHeaderParam],
    responses: {
      200: { description: '{ document }' },
      400: { description: 'Invalid body / unsupported type' },
      401: { description: 'Unauthorized' },
      413: { description: 'Knowledge base limit reached' },
    },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    let body;
    try {
      body = uploadBody.parse(await c.req.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      return openApiJsonError(c, 400, 'invalid_body', msg);
    }

    if (!ALLOWED_EXTENSIONS.test(body.filename)) {
      return openApiJsonError(c, 400, 'unsupported_type', 'Supported: PDF, XLSX, XLS, TXT, MD, CSV.');
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.fileBase64, 'base64');
    } catch {
      return openApiJsonError(c, 400, 'invalid_body', 'fileBase64 is not valid base64.');
    }
    if (buffer.length === 0) return openApiJsonError(c, 400, 'invalid_body', 'File is empty.');

    try {
      await checkQuota(auth.tenantId, buffer.length);
    } catch (err) {
      return openApiJsonError(c, 413, 'quota_exceeded', err instanceof Error ? err.message : 'Knowledge base limit reached.');
    }

    const documentId = randomUUID();
    const storagePath = storagePathFor(auth.tenantId, documentId, body.filename);

    try {
      await uploadKnowledgeFile(storagePath, buffer, body.mimeType);
      const document = await createKnowledgeDocument({
        tenant_id: auth.tenantId,
        filename: body.filename,
        mime_type: body.mimeType,
        byte_size: buffer.length,
        storage_path: storagePath,
        source_type: 'document',
      });
      await recordUsageDelta(auth.tenantId, buffer.length);
      await inngest.send({ name: 'knowledge/document.uploaded', data: { tenantId: auth.tenantId, documentId: document.id } });
      return c.json({ document });
    } catch (err) {
      await deleteKnowledgeFile(storagePath).catch(() => undefined);
      return openApiJsonError(c, 400, 'upload_failed', err instanceof Error ? err.message : 'Upload failed.');
    }
  },
});

/** DELETE /svc/v1/knowledge/documents/:id — remove a document, its graph chunks, and free its quota. */
export const knowledgeDeleteDocumentRoute = registerApiRoute(`${OPEN_API_PREFIX}/knowledge/documents/:id`, {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Delete a knowledge document',
    tags: ['Knowledge'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ ok: true }' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
  },
  handler: async (c: ParamCtx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;

    const id = c.req.param('id') ?? '';
    const document = await getKnowledgeDocument(auth.tenantId, id);
    if (!document) return openApiJsonError(c, 404, 'not_found', 'Document not found.');

    await deleteDocumentFromGraph(auth.tenantId, document.id).catch(() => undefined);
    await deleteKnowledgeFile(document.storage_path).catch(() => undefined);
    await deleteKnowledgeDocumentRow(auth.tenantId, document.id);
    await recordUsageDelta(auth.tenantId, -document.byte_size);
    return c.json({ ok: true });
  },
});

/** GET /svc/v1/knowledge/graph — capped node-link snapshot for the Knowledge page's graph view. */
export const knowledgeGraphSnapshotRoute = registerApiRoute(`${OPEN_API_PREFIX}/knowledge/graph`, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: "Node-link snapshot of the tenant's knowledge graph",
    tags: ['Knowledge'],
    parameters: [authHeaderParam],
    responses: { 200: { description: '{ nodes, edges, rebuilding? }' }, 401: { description: 'Unauthorized' } },
  },
  handler: async (c: OpenApiHandlerContext) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    void touchActivity(auth.tenantId).catch(() => undefined);
    try {
      const rebuilding = await ensureGraphFresh(auth.tenantId);
      if (rebuilding) return c.json({ nodes: [], edges: [], rebuilding: true });
      const snapshot = await getTenantGraphSnapshot(auth.tenantId);
      return c.json(snapshot);
    } catch (err) {
      return openApiJsonError(c, 400, 'graph_read_failed', err instanceof Error ? err.message : 'Failed to read graph.');
    }
  },
});

export const knowledgeRoutes = [
  knowledgeListDocumentsRoute,
  knowledgeUploadDocumentRoute,
  knowledgeDeleteDocumentRoute,
  knowledgeGraphSnapshotRoute,
];
