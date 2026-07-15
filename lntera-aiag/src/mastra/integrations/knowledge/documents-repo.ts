import { getSupabase } from '../shared/supabase';

const TABLE = 'tenant_knowledge_documents';
export const KNOWLEDGE_BUCKET = 'tenant-knowledge-docs';

export type KnowledgeDocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type KnowledgeSourceType = 'document' | 'chat';

export interface TenantKnowledgeDocument {
  id: string;
  tenant_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  source_type: KnowledgeSourceType;
  status: KnowledgeDocumentStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function storagePathFor(tenantId: string, documentId: string, filename: string): string {
  return `${tenantId}/${documentId}/${filename}`;
}

/** Where a client-side-extracted PDF's plain text is stashed (see knowledge.ts's upload route and
 *  pdf-extract.ts on the web side) — lets the ingest pipeline skip the server's own, resource-capped
 *  PDF parser entirely when the browser already did the work. */
export function extractedTextPathFor(tenantId: string, documentId: string): string {
  return `${tenantId}/${documentId}/extracted.txt`;
}

export async function createKnowledgeDocument(input: {
  tenant_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  source_type: KnowledgeSourceType;
}): Promise<TenantKnowledgeDocument> {
  const { data, error } = await getSupabase().from(TABLE).insert(input).select('*').single();
  if (error || !data) throw new Error(`Failed to create knowledge document: ${error?.message ?? 'unknown error'}`);
  return data as TenantKnowledgeDocument;
}

export async function listKnowledgeDocuments(tenantId: string): Promise<TenantKnowledgeDocument[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list knowledge documents (${tenantId}): ${error.message}`);
  return (data ?? []) as TenantKnowledgeDocument[];
}

export async function getKnowledgeDocument(tenantId: string, id: string): Promise<TenantKnowledgeDocument | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to read knowledge document (${tenantId}/${id}): ${error.message}`);
  return (data as TenantKnowledgeDocument | null) ?? null;
}

export async function updateKnowledgeDocumentStatus(
  id: string,
  status: KnowledgeDocumentStatus,
  errorMessage?: string | null,
): Promise<void> {
  const { error } = await getSupabase()
    .from(TABLE)
    .update({ status, error_message: errorMessage ?? null })
    .eq('id', id);
  if (error) throw new Error(`Failed to update knowledge document status (${id}): ${error.message}`);
}

export async function deleteKnowledgeDocumentRow(tenantId: string, id: string): Promise<boolean> {
  const { data, error } = await getSupabase().from(TABLE).delete().eq('tenant_id', tenantId).eq('id', id).select('id');
  if (error) throw new Error(`Failed to delete knowledge document (${tenantId}/${id}): ${error.message}`);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

export async function uploadKnowledgeFile(path: string, buffer: Buffer, contentType: string): Promise<void> {
  const { error } = await getSupabase()
    .storage.from(KNOWLEDGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Failed to upload knowledge file (${path}): ${error.message}`);
}

export async function downloadKnowledgeFile(path: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(KNOWLEDGE_BUCKET).download(path);
  if (error || !data) throw new Error(`Failed to download knowledge file (${path}): ${error?.message ?? 'not found'}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteKnowledgeFile(path: string): Promise<void> {
  const { error } = await getSupabase().storage.from(KNOWLEDGE_BUCKET).remove([path]);
  if (error) throw new Error(`Failed to delete knowledge file (${path}): ${error.message}`);
}
