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
        headings: { en: truncate(stripMarkdown(input.heading), 64) },
        contents: { en: truncate(stripMarkdown(input.content), 240) },
        // web_url (NOT url): web/desktop open the deep link in the app/tab. We deliberately DON'T set a
        // url/app_url for native — that would launch an external browser. Native taps open the app and
        // our in-app click handler (web/src/lib/push.ts) navigates using data.threadId.
        ...(input.url ? { web_url: input.url } : {}),
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

/**
 * Push payloads are plain text — strip Markdown so LLM-written copy doesn't show raw `**`, `###`, `***`,
 * backticks, or `[text](url)` on the lock screen. Best-effort, order matters (fences → code → links →
 * headings → emphasis).
 */
function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '• ') // bullet markers → •
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .replace(/\*\*\*|\*\*|\*|___|__|_/g, '') // bold / italic markers (incl. ***)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
