// Daily: FalkorDB has no safe cold-tiering (see project notes on DUMP/RESTORE's upstream bugs), so a
// tenant with no knowledge-base activity in 90 days gets their graph GRAPH.DELETE'd to free RAM.
// Source documents stay in Storage untouched; see eviction.ts for the rebuild-on-return path.
import { inngest } from '../client';
import { getSupabase } from '../../integrations/shared/supabase';
import { deleteTenantGraph } from '../../integrations/knowledge/falkordb-client';

const INACTIVITY_DAYS = 90;

export const knowledgeEvictionSweepFn = inngest.createFunction(
  { id: 'knowledge-eviction-sweep', triggers: [{ cron: '17 3 * * *' }] },
  async ({ step }) => {
    const evicted = await step.run('evict-inactive-graphs', async () => {
      const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('tenant_knowledge_usage')
        .select('tenant_id')
        .lt('last_activity_at', cutoff)
        .is('graph_evicted_at', null);
      if (error) throw new Error(`Failed to list inactive knowledge tenants: ${error.message}`);

      let n = 0;
      for (const row of (data ?? []) as { tenant_id: string }[]) {
        try {
          await deleteTenantGraph(row.tenant_id);
          await supabase
            .from('tenant_knowledge_usage')
            .update({ graph_evicted_at: new Date().toISOString() })
            .eq('tenant_id', row.tenant_id);
          n++;
        } catch {
          /* one tenant's eviction failure must not abort the sweep */
        }
      }
      return n;
    });
    return { evicted };
  },
);
