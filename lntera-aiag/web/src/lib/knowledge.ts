// Shared client for the tenant knowledge base — used by the chat composer's attach flow and the
// /knowledge page, so the upload/validation logic lives in exactly one place.
import { apiErrorMessage } from './integrations';

export const ALLOWED_KNOWLEDGE_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.txt', '.md', '.csv'];
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 10 * 1024 * 1024;

export type KnowledgeDocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  status: KnowledgeDocumentStatus;
  source_type: 'document' | 'chat';
  error_message: string | null;
  created_at: string;
}

export interface KnowledgeUsage {
  bytes_used: number;
  byte_limit: number;
  graph_evicted_at: string | null;
}

export interface KnowledgeGraphNode {
  id: string;
  caption: string;
  type?: string;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  rebuilding?: boolean;
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export function isAllowedKnowledgeFile(filename: string): boolean {
  const ext = `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
  return ALLOWED_KNOWLEDGE_EXTENSIONS.includes(ext);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>" — keep only the payload.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadKnowledgeDocument(api: Api, file: File): Promise<KnowledgeDocument> {
  const fileBase64 = await fileToBase64(file);
  const res = await api('/svc/v1/knowledge/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', fileBase64 }),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Upload failed.'));
  const data = (await res.json()) as { document: KnowledgeDocument };
  return data.document;
}

export async function listKnowledgeDocuments(api: Api): Promise<{ documents: KnowledgeDocument[]; usage: KnowledgeUsage }> {
  const res = await api('/svc/v1/knowledge/documents');
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load your knowledge base.'));
  return (await res.json()) as { documents: KnowledgeDocument[]; usage: KnowledgeUsage };
}

export async function deleteKnowledgeDocument(api: Api, id: string): Promise<void> {
  const res = await api(`/svc/v1/knowledge/documents/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Delete failed.'));
}

export async function fetchKnowledgeGraph(api: Api): Promise<KnowledgeGraphSnapshot> {
  const res = await api('/svc/v1/knowledge/graph');
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load the knowledge graph.'));
  return (await res.json()) as KnowledgeGraphSnapshot;
}
