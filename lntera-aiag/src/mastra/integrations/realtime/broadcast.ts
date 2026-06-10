import { logErrorBrief } from '../../logger/compact-error';
import { getSupabaseServiceConfig } from '../shared/supabase';

/** Payload delivered to a tenant's web/native clients over Supabase Realtime. */
export interface TenantNotificationPayload {
  id: string;
  text: string;
  kind: 'marketplace' | 'connection';
  platform?: string;
  category?: string;
  code?: string;
  createdAt: string;
}

/** Per-tenant private Broadcast topic. Clients subscribe to `tenant:<id>` (RLS-gated). */
export function tenantTopic(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Broadcast a notification to a tenant's clients via the Supabase Realtime REST endpoint.
 * Server-side, authenticated with the service key (bypasses the RLS policy that gates which
 * clients may *receive* the topic). Best-effort: returns false (and logs) instead of throwing.
 */
export async function broadcastTenantNotification(
  tenantId: string,
  payload: TenantNotificationPayload,
): Promise<boolean> {
  const cfg = getSupabaseServiceConfig();
  if (!cfg) return false;

  try {
    const res = await fetch(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        messages: [
          { topic: tenantTopic(tenantId), event: 'notification', private: true, payload },
        ],
      }),
    });
    if (!res.ok) {
      logErrorBrief(`[realtime] broadcast failed (${res.status}) tenant=${tenantId}`, await safeText(res));
      return false;
    }
    return true;
  } catch (err) {
    logErrorBrief(`[realtime] broadcast threw tenant=${tenantId}`, err);
    return false;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
