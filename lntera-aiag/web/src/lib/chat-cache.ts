import { openDB, type IDBPDatabase } from 'idb';
import type { ChatThread, HistoryMessage } from './threads';

// Offline-first cache for chat sessions + the newest page of each thread's messages.
// Keyed/namespaced by `${tenant}:${userId}` (the `scope`) so a shared device never bleeds
// one account's history into another. All ops are best-effort: IndexedDB can be unavailable
// (private mode / quota), so failures degrade to "no cache" rather than breaking the UI.

const DB_NAME = 'lntera-chat';
const THREADS = 'threads';
const MESSAGES = 'messages';
/** Cap the cached newest-page so storage stays small; older pages need the network. */
const NEWEST_PAGE_CAP = 60;

let dbp: Promise<IDBPDatabase> | null = null;
function getDb(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(THREADS)) db.createObjectStore(THREADS);
        if (!db.objectStoreNames.contains(MESSAGES)) db.createObjectStore(MESSAGES);
      },
    }).catch((err) => {
      dbp = null;
      throw err;
    });
  }
  return dbp;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

const msgKey = (scope: string, threadId: string) => `${scope}::${threadId}`;

export async function getCachedThreads(scope: string): Promise<ChatThread[] | undefined> {
  return safe(async () => (await (await getDb()).get(THREADS, scope)) as ChatThread[] | undefined, undefined);
}

export async function setCachedThreads(scope: string, threads: ChatThread[]): Promise<void> {
  await safe(async () => {
    await (await getDb()).put(THREADS, threads, scope);
  }, undefined);
}

export async function getCachedMessages(scope: string, threadId: string): Promise<HistoryMessage[] | undefined> {
  return safe(
    async () => (await (await getDb()).get(MESSAGES, msgKey(scope, threadId))) as HistoryMessage[] | undefined,
    undefined,
  );
}

export async function setCachedMessages(
  scope: string,
  threadId: string,
  messages: HistoryMessage[],
): Promise<void> {
  await safe(async () => {
    await (await getDb()).put(MESSAGES, messages.slice(-NEWEST_PAGE_CAP), msgKey(scope, threadId));
  }, undefined);
}

/** Merge new turns into the cached newest-page (dedupe by id, keep chronological, cap size). */
export async function appendCachedMessages(
  scope: string,
  threadId: string,
  incoming: HistoryMessage[],
): Promise<void> {
  await safe(async () => {
    const db = await getDb();
    const existing = ((await db.get(MESSAGES, msgKey(scope, threadId))) as HistoryMessage[] | undefined) ?? [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    const merged = [...byId.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-NEWEST_PAGE_CAP);
    await db.put(MESSAGES, merged, msgKey(scope, threadId));
  }, undefined);
}

export async function removeCachedThread(scope: string, threadId: string): Promise<void> {
  await safe(async () => {
    await (await getDb()).delete(MESSAGES, msgKey(scope, threadId));
  }, undefined);
}
