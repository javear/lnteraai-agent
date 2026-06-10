import { logErrorBrief } from '../../logger/compact-error';

export interface TenantPushInput {
  heading: string;
  content: string;
  url?: string;
  data?: Record<string, unknown>;
}

const ONESIGNAL_API = 'https://onesignal.com/api/v1/notifications';

/**
 * Send an OS push to every device of a tenant via OneSignal, targeting the `tenant_id` tag.
 * Clients register external_id = user uuid + tag tenant_id = tenant uuid, so we store NO player
 * ids in our DB. Best-effort + gated on env, so dev without OneSignal silently no-ops.
 */
export async function sendTenantPush(tenantId: string, input: TenantPushInput): Promise<boolean> {
  const appId = process.env.ONESIGNAL_APP_ID?.trim();
  const restKey = process.env.ONESIGNAL_REST_API_KEY?.trim();
  if (!appId || !restKey) return false;

  try {
    const res = await fetch(ONESIGNAL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Basic ${restKey}`,
      },
      body: JSON.stringify({
        app_id: appId,
        filters: [{ field: 'tag', key: 'tenant_id', relation: '=', value: tenantId }],
        headings: { en: truncate(input.heading, 64) },
        contents: { en: truncate(input.content, 240) },
        ...(input.url ? { url: input.url } : {}),
        ...(input.data ? { data: input.data } : {}),
      }),
    });
    if (!res.ok) {
      logErrorBrief(`[onesignal] push failed (${res.status}) tenant=${tenantId}`, await safeText(res));
      return false;
    }
    return true;
  } catch (err) {
    logErrorBrief(`[onesignal] push threw tenant=${tenantId}`, err);
    return false;
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
