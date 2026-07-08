// Inactive-tenant lifecycle: after 90 days with no knowledge-base activity, the tenant's FalkorDB
// graph is deleted to free RAM (see sweep-knowledge-eviction.ts). We deliberately do NOT try to
// restore it from a FalkorDB snapshot — DUMP/RESTORE has open upstream crash/truncation bugs for
// this exact use case. Instead the graph rebuilds from the original documents kept in Storage.
import { getSupabase } from '../shared/supabase';
import { inngest } from '../../inngest/client';
import { listKnowledgeDocuments } from './documents-repo';

const TABLE = 'tenant_knowledge_usage';

export async function isGraphEvicted(tenantId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('graph_evicted_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read knowledge usage (${tenantId}): ${error.message}`);
  return Boolean((data as { graph_evicted_at: string | null } | null)?.graph_evicted_at);
}

/** Re-queues ingestion for every ready document and clears the evicted flag. */
export async function triggerGraphRebuild(tenantId: string): Promise<number> {
  const documents = await listKnowledgeDocuments(tenantId);
  const ready = documents.filter((d) => d.status === 'ready');
  for (const doc of ready) {
    await inngest.send({ name: 'knowledge/document.uploaded', data: { tenantId, documentId: doc.id } });
  }
  const { error } = await getSupabase().from(TABLE).update({ graph_evicted_at: null }).eq('tenant_id', tenantId);
  if (error) throw new Error(`Failed to clear eviction flag (${tenantId}): ${error.message}`);
  return ready.length;
}

/** Call at the top of a knowledge read/write path. Returns true if a rebuild was just kicked off —
 *  callers should tell the user their knowledge base is repopulating rather than treating an empty
 *  graph as "no results". Best-effort by design: a failure here must never block the caller's own work. */
export async function ensureGraphFresh(tenantId: string): Promise<boolean> {
  const evicted = await isGraphEvicted(tenantId).catch(() => false);
  if (!evicted) return false;
  await triggerGraphRebuild(tenantId).catch(() => undefined);
  return true;
}
