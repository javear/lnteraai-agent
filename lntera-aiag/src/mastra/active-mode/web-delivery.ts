import { randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import { generalAgent } from '../agents/general-agent';
import { logErrorBrief } from '../logger/compact-error';
import {
  broadcastTenantNotification,
  type NotificationAction,
  type NotificationContextRef,
  type TenantNotificationPayload,
} from '../integrations/realtime/broadcast';
import { sendTenantPush } from '../integrations/onesignal/push';
import { webAppAbsoluteUrl } from '../server/web-app-origin';

export interface DeliverTenantWebNotificationInput {
  tenantId: string;
  /** The agent-generated notification text (same text sent to Discord). */
  text: string;
  /** Short title for the OS push (defaults derived from the event). */
  heading?: string;
  marketplace?: { platform?: string; category?: string; code?: string };
  kind?: 'marketplace' | 'connection' | 'product_sync';
  /** Token-free action buttons (product-sync prompts). */
  actions?: NotificationAction[];
  contextRef?: NotificationContextRef;
  deterministic?: boolean;
  /** Realtime broadcast (in-app popup). Default true; set false for coalesced persist-only writes. */
  broadcast?: boolean;
  /** OS push. Default true; set false for coalesced persist-only writes. */
  push?: boolean;
}

/** Per-tenant "Notifications" thread — the dedicated chat where proactive notifications persist. */
export function notificationsThreadId(tenantId: string): string {
  return `web:${tenantId}:notifications`;
}

/**
 * Deliver an active-mode notification to the tenant's own platform (web/desktop/mobile):
 *   1. Persist it to the tenant's "Notifications" chat (so it survives reload + stays coherent).
 *   2. Supabase Realtime broadcast → in-app popup + live typing (when the app is open).
 *   3. OneSignal push → OS notification (when the app is backgrounded/closed).
 * All best-effort and independent of whether the tenant also has Discord linked.
 */
export async function deliverTenantWebNotification(input: DeliverTenantWebNotificationInput): Promise<void> {
  const payload: TenantNotificationPayload = {
    id: randomUUID(),
    text: input.text,
    kind: input.kind ?? 'marketplace',
    platform: input.marketplace?.platform,
    category: input.marketplace?.category,
    code: input.marketplace?.code,
    createdAt: new Date().toISOString(),
    actions: input.actions,
    contextRef: input.contextRef,
    deterministic: input.deterministic,
  };

  const tasks: Array<Promise<unknown>> = [persistWebNotification(input.tenantId, payload)];
  if (input.broadcast !== false) tasks.push(broadcastTenantNotification(input.tenantId, payload));
  if (input.push !== false) {
    tasks.push(
      sendTenantPush(input.tenantId, {
        heading: input.heading ?? 'Lntera',
        content: input.text,
        url: notificationsUrl(input.tenantId),
        data: { kind: payload.kind, platform: payload.platform, category: payload.category, code: payload.code },
      }),
    );
  }
  await Promise.allSettled(tasks);
}

/**
 * Save the notification as an assistant message in the tenant's "Notifications" thread. Uses the
 * broadcast `payload.id` as the message id so the live-typed copy and this persisted copy dedupe.
 */
async function persistWebNotification(tenantId: string, payload: TenantNotificationPayload): Promise<void> {
  try {
    const memory = await generalAgent.getMemory();
    if (!memory) return;
    const threadId = notificationsThreadId(tenantId);

    const existing = await memory.getThreadById({ threadId }).catch(() => null);
    if (!existing) {
      await memory.saveThread({
        thread: {
          id: threadId,
          resourceId: tenantId,
          title: 'Active Agent',
          metadata: { channel: 'web', kind: 'notifications' },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    const message: MastraDBMessage = {
      id: payload.id,
      role: 'assistant',
      createdAt: new Date(payload.createdAt),
      threadId,
      resourceId: tenantId,
      content: {
        format: 2,
        parts: [{ type: 'text', text: payload.text }],
        metadata: {
          channel: 'web',
          source: 'notification',
          kind: payload.kind,
          platform: payload.platform,
          category: payload.category,
          code: payload.code,
          // Persisted so the web client re-renders the action buttons on history reload.
          actions: payload.actions,
          contextRef: payload.contextRef,
          deterministic: payload.deterministic,
        },
      },
    };
    await memory.saveMessages({ messages: [message] });
  } catch (err) {
    logErrorBrief(`[active] persist web notification failed tenant=${tenantId}`, err);
  }
}

/** Push launch URL → opens the Notifications chat. Targets WEB_APP_ORIGIN (e.g. the Vercel app) when
 * set, else MASTRA_PUBLIC_BASE_URL + /app so pushes opened on other devices land on the right host. */
function notificationsUrl(tenantId: string): string {
  return webAppAbsoluteUrl(`/c/${notificationsThreadId(tenantId)}`);
}
