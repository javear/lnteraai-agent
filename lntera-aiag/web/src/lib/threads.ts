// Typed client for the per-user chat-session endpoints (`/svc/v1/chat/*`).
import type { NotificationAction, NotificationContextRef } from './notifications';
import type { ChartSpec } from './insights';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** "Provider · model" that produced an assistant turn — served from history (Mastra message metadata). */
  model?: string;
  /** Token-free product-sync buttons, re-hydrated from message metadata so they survive reload. */
  actions?: NotificationAction[];
  contextRef?: NotificationContextRef;
  /** Insight charts, re-hydrated from message metadata so they survive reload. */
  charts?: ChartSpec[];
}

export interface MessagesPage {
  messages: HistoryMessage[];
  hasMore: boolean;
  /** createdAt of the oldest loaded message — pass as `before` to load the previous page. */
  nextBefore: string | null;
}

/** The shared per-tenant "Notifications" thread id — proactive agent notifications persist here. */
export function notificationsThreadId(tenant: string): string {
  return `web:${tenant}:notifications`;
}

const BASE = '/svc/v1/chat/threads';

export async function listThreads(api: Api): Promise<ChatThread[]> {
  const res = await api(BASE);
  if (!res.ok) throw new Error(`Failed to load chats (${res.status}).`);
  const data = (await res.json()) as { threads?: ChatThread[] };
  return data.threads ?? [];
}

export async function createThread(api: Api, title?: string): Promise<ChatThread> {
  const res = await api(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to create chat (${res.status}).`);
  return (await res.json()) as ChatThread;
}

export async function getMessages(
  api: Api,
  threadId: string,
  before?: string | null,
  limit = 30,
): Promise<MessagesPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', before);
  const res = await api(`${BASE}/${encodeURIComponent(threadId)}/messages?${q.toString()}`);
  // A brand-new or not-yet-owned thread has no server messages — that's "empty", not an error.
  // Returning an empty page (instead of throwing) keeps optimistic/cached messages and avoids a
  // noisy 404 during the create→send→reload window.
  if (res.status === 404) return { messages: [], hasMore: false, nextBefore: null };
  if (!res.ok) throw new Error(`Failed to load messages (${res.status}).`);
  return (await res.json()) as MessagesPage;
}

/**
 * Ask the server to generate a short, summary title for a session from its first exchange.
 * Best-effort: returns the (possibly unchanged) thread; never throws on a non-OK response.
 */
export async function generateTitle(api: Api, threadId: string): Promise<ChatThread | null> {
  try {
    const res = await api(`${BASE}/${encodeURIComponent(threadId)}/title`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as ChatThread;
  } catch {
    return null;
  }
}

export async function renameThread(api: Api, threadId: string, title: string): Promise<ChatThread> {
  const res = await api(`${BASE}/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Rename failed (${res.status}).`);
  return (await res.json()) as ChatThread;
}

export async function deleteThread(api: Api, threadId: string): Promise<void> {
  const res = await api(`${BASE}/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
}
