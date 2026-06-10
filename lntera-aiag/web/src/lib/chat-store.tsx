import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth';
import { useOnlineStatus } from './pwa';
import {
  createThread,
  deleteThread as apiDeleteThread,
  listThreads,
  renameThread,
  type ChatThread,
} from './threads';
import { getCachedThreads, removeCachedThread, setCachedThreads } from './chat-cache';
import type { Session } from '@supabase/supabase-js';

interface ChatStore {
  threads: ChatThread[];
  loading: boolean;
  /** `${tenant}:${userId}` — namespaces the IndexedDB cache. */
  scope: string;
  refreshThreads: () => Promise<void>;
  createSession: (title?: string) => Promise<ChatThread>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Local-only reorder/title bump after a turn (server already updated `updatedAt`). */
  touchThread: (id: string, patch: { title?: string; updatedAt?: string }) => void;
}

const ChatContext = createContext<ChatStore | null>(null);

function deriveScope(session: Session | null): string {
  const tenant =
    (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ??
    session?.user.id ??
    'web:anon';
  const userId = session?.user.id ?? 'anon';
  return `${tenant}:${userId}`;
}

const byUpdatedDesc = (a: ChatThread, b: ChatThread) => b.updatedAt.localeCompare(a.updatedAt);

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const { api, session } = useAuth();
  const online = useOnlineStatus();
  const scope = deriveScope(session);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);

  // `api` identity changes whenever the token refreshes; keep it in a ref so it isn't an effect dep.
  const apiRef = useRef(api);
  apiRef.current = api;

  const persist = useCallback(
    (next: ChatThread[]) => {
      void setCachedThreads(scope, next);
      return next;
    },
    [scope],
  );

  const refreshThreads = useCallback(async () => {
    try {
      const list = await listThreads(apiRef.current);
      setThreads(persist([...list].sort(byUpdatedDesc)));
    } catch {
      /* offline or transient error — keep whatever we have (cache) */
    }
  }, [persist]);

  // Hydrate from cache instantly (offline-OK), then revalidate from the server when online.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const cached = await getCachedThreads(scope);
      if (!cancelled && cached) setThreads([...cached].sort(byUpdatedDesc));
      if (online) await refreshThreads();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, online, refreshThreads]);

  const createSession = useCallback(
    async (title?: string) => {
      const t = await createThread(apiRef.current, title);
      setThreads((prev) => persist([t, ...prev.filter((x) => x.id !== t.id)]));
      return t;
    },
    [persist],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await apiDeleteThread(apiRef.current, id);
      setThreads((prev) => persist(prev.filter((x) => x.id !== id)));
      void removeCachedThread(scope, id);
    },
    [persist, scope],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const updated = await renameThread(apiRef.current, id, title);
      setThreads((prev) => persist(prev.map((x) => (x.id === id ? updated : x)).sort(byUpdatedDesc)));
    },
    [persist],
  );

  const touchThread = useCallback(
    (id: string, patch: { title?: string; updatedAt?: string }) => {
      setThreads((prev) =>
        persist(prev.map((x) => (x.id === id ? { ...x, ...patch } : x)).sort(byUpdatedDesc)),
      );
    },
    [persist],
  );

  return (
    <ChatContext.Provider
      value={{ threads, loading, scope, refreshThreads, createSession, deleteSession, renameSession, touchThread }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChats(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChats must be used within a ChatSessionsProvider');
  return ctx;
}
