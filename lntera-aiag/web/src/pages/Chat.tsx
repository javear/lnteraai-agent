import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, Sparkles } from 'lucide-react';
import { useAuth } from '../auth';
import { useApp } from '../components/AppLayout';
import { useMastra } from '../lib/mastra';
import { parseSuggestions, streamChat } from '../lib/chat';
import { apiErrorMessage, isAnyLlmActive } from '../lib/integrations';
import { useChats } from '../lib/chat-store';
import { useNotifications, type TenantNotification } from '../lib/notifications';
import { generateTitle, getMessages, type HistoryMessage } from '../lib/threads';
import { appendCachedMessages, getCachedMessages, setCachedMessages } from '../lib/chat-cache';
import { useOnlineStatus } from '../lib/pwa';
import { ProviderConnect, PROVIDER_CONNECT_CONFIGS } from '../components/ProviderConnect';
import { Alert, Button, Logo, Modal } from '../ui';
import { InsightSettings } from '../components/InsightSettings';
import { AutopilotSettings } from '../components/AutopilotSettings';
import { FinanceSettings } from '../components/FinanceSettings';
import { TaxSettings } from '../components/TaxSettings';
import { MessageBubble, type ChatMessage } from '../components/chat/Message';
import { Suggestions } from '../components/chat/Suggestions';
import { Composer } from '../components/chat/Composer';
import { ChatEmptyArt } from '../components/Lottie';

let seq = 0;
const newId = () => `m${++seq}-${Date.now()}`;
const PAGE = 30;
const EXAMPLES = ['List my connected shops', "Show today's orders", 'Search my products'];

function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || 'New chat';
}

function prependUnique(older: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const ids = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => !ids.has(m.id));
  return fresh.length ? [...fresh, ...current] : current;
}

/** Chips to show = the suggestions on the most recent assistant message (matches the live turn). */
function trailingSuggestionsOf(msgs: Array<{ role: string; content: string }>): string[] {
  const last = msgs[msgs.length - 1];
  return last && last.role === 'assistant' ? parseSuggestions(last.content).suggestions : [];
}

export default function Chat() {
  const { session, api } = useAuth();
  const { status, loadingStatus, refreshStatus } = useApp();
  const { scope, createSession, touchThread } = useChats();
  const { subscribe: subscribeNotifications } = useNotifications();
  const client = useMastra();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const { threadId: routeThreadId } = useParams();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectProvider, setConnectProvider] = useState<'groq' | 'gemini' | null>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [financeEnabled, setFinanceEnabled] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const stopRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyForRef = useRef<string | undefined>(undefined); // which thread's history is loaded
  const nearBottomRef = useRef(true);
  const hasMoreRef = useRef(false);
  const oldestCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const typingTimersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const seenNotifRef = useRef<Set<string>>(new Set());
  // In-memory per-thread messages (persistent only) so switching back to a visited thread restores
  // instantly — no blank/flash while IndexedDB + server revalidate.
  const memCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // Threads created in THIS browser session: their first turn may not be on the server yet, so an
  // empty server response shouldn't blank the optimistic messages.
  const createdThisSessionRef = useRef<Set<string>>(new Set());
  // Keep latest values addressable from stable callbacks / event handlers.
  const apiRef = useRef(api);
  apiRef.current = api;
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  // `resource` (memory owner) is the tenant — the server enforces this from the token.
  const resource =
    (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ??
    session?.user.id ??
    'web:anon';
  const notifThreadId = `web:${resource}:notifications`;
  const isNotificationsThread = routeThreadId === notifThreadId;
  const routeThreadIdRef = useRef(routeThreadId);
  routeThreadIdRef.current = routeThreadId;
  const notifThreadIdRef = useRef(notifThreadId);
  notifThreadIdRef.current = notifThreadId;
  const llmOk = isAnyLlmActive(status);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const loadHistory = useCallback(
    async (threadId: string, silent: boolean) => {
      if (!silent) {
        // Show the best-available immediately; only spin when we have NOTHING (true first visit).
        const hasMem = (memCacheRef.current.get(threadId)?.length ?? 0) > 0;
        const cached = await getCachedMessages(scope, threadId);
        if (historyForRef.current !== threadId) return;
        if (!hasMem && cached && cached.length) {
          setMessages(cached);
          setSuggestions(trailingSuggestionsOf(cached));
          setLoadingHistory(false);
        } else {
          setLoadingHistory(!hasMem && !(cached && cached.length));
        }
      }
      if (!onlineRef.current) {
        setLoadingHistory(false);
        hasMoreRef.current = false;
        return;
      }
      try {
        const page = await getMessages(apiRef.current, threadId, null, PAGE);
        if (historyForRef.current !== threadId) return;
        // A just-created thread whose first turn isn't on the server yet → keep the optimistic
        // messages instead of blanking to an empty list.
        if (
          page.messages.length === 0 &&
          createdThisSessionRef.current.has(threadId) &&
          (memCacheRef.current.get(threadId)?.length ?? 0) > 0
        ) {
          setLoadingHistory(false);
          return;
        }
        // The model label is served from history (Mastra message metadata); fall back to the client
        // cache / in-memory turns by id only when the server didn't include it.
        const cachedNow = await getCachedMessages(scope, threadId);
        if (historyForRef.current !== threadId) return;
        const modelById = new Map<string, string>();
        for (const m of cachedNow ?? []) if (m.model) modelById.set(m.id, m.model);
        for (const m of memCacheRef.current.get(threadId) ?? []) if (m.model) modelById.set(m.id, m.model);
        const merged = page.messages.map((m) =>
          m.role === 'assistant' && !m.model && modelById.has(m.id) ? { ...m, model: modelById.get(m.id) } : m,
        );
        setMessages(merged);
        setSuggestions(trailingSuggestionsOf(merged));
        hasMoreRef.current = page.hasMore;
        oldestCursorRef.current = page.nextBefore;
        void setCachedMessages(scope, threadId, merged);
        nearBottomRef.current = true;
        requestAnimationFrame(() => scrollToBottom('auto'));
      } catch {
        /* offline / transient — keep whatever the cache gave us */
      } finally {
        if (historyForRef.current === threadId) setLoadingHistory(false);
      }
    },
    [scope, scrollToBottom],
  );

  const loadOlder = useCallback(async (threadId: string) => {
    if (loadingOlderRef.current || !oldestCursorRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const page = await getMessages(apiRef.current, threadId, oldestCursorRef.current, PAGE);
      if (historyForRef.current !== threadId) return;
      hasMoreRef.current = page.hasMore;
      oldestCursorRef.current = page.nextBefore;
      setMessages((prev) => prependUnique(page.messages, prev));
      requestAnimationFrame(() => {
        const e2 = scrollRef.current;
        if (e2) e2.scrollTop = e2.scrollHeight - prevHeight + prevTop;
      });
    } catch {
      /* ignore — user can retry by scrolling */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  // Load (or clear) history whenever the active thread changes. The `historyForRef` guard keeps
  // our own post-create navigation from wiping the in-flight conversation.
  useEffect(() => {
    if (routeThreadId === historyForRef.current) return;
    historyForRef.current = routeThreadId;
    // Restore the visited thread's messages synchronously (instant, no blank); transient heads-ups
    // from the previous thread are dropped because mem holds persistent messages only.
    const restored = routeThreadId ? (memCacheRef.current.get(routeThreadId) ?? []) : [];
    setMessages(restored);
    setSuggestions(trailingSuggestionsOf(restored));
    setError(null);
    hasMoreRef.current = false;
    oldestCursorRef.current = null;
    nearBottomRef.current = true;
    if (!routeThreadId) {
      setLoadingHistory(false);
      return;
    }
    void loadHistory(routeThreadId, false);
  }, [routeThreadId, loadHistory]);

  // Keep the in-memory store in sync with the loaded thread's persistent messages (excludes
  // transient heads-ups so they're never restored or cached).
  useEffect(() => {
    const tid = historyForRef.current;
    if (tid) memCacheRef.current.set(tid, messages.filter((m) => !m.transient));
  }, [messages]);

  // On reconnect, silently re-sync the newest page for the open thread.
  useEffect(() => {
    if (online && routeThreadId && historyForRef.current === routeThreadId && !streamingRef.current) {
      void loadHistory(routeThreadId, true);
    }
  }, [online, routeThreadId, loadHistory]);

  // Autoscroll to the newest message only when the user is already near the bottom. During a stream
  // the message mutates per token, so track instantly (smooth would restart its animation dozens of
  // times/sec → jitter); reserve smooth scrolling for discrete events (new turn, suggestions).
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom(streamingRef.current ? 'auto' : 'smooth');
  }, [messages, suggestions, scrollToBottom]);

  // Auto-write: an active-agent message types itself into the chat. In its home (the Active Agent
  // chat) it's a persistent message (also saved server-side, deduped by n.id). In any OTHER open
  // chat it's a TRANSIENT heads-up (with a CTA) — shown but never saved to that thread.
  useEffect(() => {
    return subscribeNotifications((n: TenantNotification) => {
      const text = n.text?.trim();
      if (!text || seenNotifRef.current.has(n.id)) return;
      seenNotifRef.current.add(n.id);
      const id = n.id;
      const transient = routeThreadIdRef.current !== notifThreadIdRef.current;
      nearBottomRef.current = true;
      setMessages((m) =>
        m.some((x) => x.id === id)
          ? m
          : [
              ...m,
              {
                id,
                role: 'assistant',
                content: '',
                proactive: true,
                transient,
                pending: true,
                createdAt: n.createdAt,
                actions: n.actions,
                contextRef: n.contextRef,
                charts: n.charts,
              },
            ],
      );

      const reduce =
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) {
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, content: text, pending: false } : x)));
        return;
      }
      let i = 0;
      const step = Math.max(2, Math.round(text.length / 60));
      const timer = setInterval(() => {
        i = Math.min(text.length, i + step);
        const slice = text.slice(0, i);
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, content: slice, pending: false } : x)));
        if (i >= text.length) {
          clearInterval(timer);
          typingTimersRef.current.delete(timer);
        }
      }, 30);
      typingTimersRef.current.add(timer);
    });
  }, [subscribeNotifications]);

  // Stop any in-flight typewriters when leaving the chat.
  useEffect(() => {
    const timers = typingTimersRef.current;
    return () => {
      timers.forEach((t) => clearInterval(t));
      timers.clear();
    };
  }, []);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 80 && hasMoreRef.current && !loadingOlderRef.current && onlineRef.current && routeThreadId) {
      void loadOlder(routeThreadId);
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming) return;
    setError(null);
    setSuggestions([]);
    setInput('');

    const startedAt = new Date().toISOString();
    const userMsgId = newId();
    const aiId = newId();
    nearBottomRef.current = true;
    setMessages((m) => [
      ...m,
      { id: userMsgId, role: 'user', content, createdAt: startedAt },
      { id: aiId, role: 'assistant', content: '', pending: true, tool: null, createdAt: startedAt },
    ]);
    setStreaming(true);
    stopRef.current = false;

    // A fresh session has no thread yet — create it (with a provisional title) before streaming.
    const isNewSession = !routeThreadId;
    let threadId = routeThreadId;
    if (!threadId) {
      try {
        const created = await createSession(deriveTitle(content));
        threadId = created.id;
        createdThisSessionRef.current.add(created.id); // keep optimistic messages if reloaded early
        historyForRef.current = created.id; // suppress the route-change reload below
        navigate(`/c/${created.id}`, { replace: true });
      } catch {
        setMessages((m) => m.filter((x) => x.id !== aiId));
        setError('Could not start a new chat. Check your connection and try again.');
        setStreaming(false);
        return;
      }
    }

    let acc = '';
    let usedModel: string | undefined;
    let errored = false;
    const apply = (full: string) =>
      setMessages((m) =>
        // Clear `tool` too: once the answer is streaming, the "Using …" pulse must stop (otherwise it
        // looks stuck/loading even though text has arrived).
        m.map((x) => (x.id === aiId ? { ...x, content: parseSuggestions(full).body, pending: false, tool: null } : x)),
      );

    await streamChat(
      client,
      content,
      threadId,
      resource,
      {
        onText: (delta) => {
          acc += delta;
          apply(acc);
        },
        onToolStart: (tool) => setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, tool } : x))),
        onModel: (label) => {
          usedModel = label;
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, model: label } : x)));
        },
        // Show the error/limit message AS the assistant reply (never an empty bubble).
        onTripwire: (code, reason) => {
          if (code === 'groq_not_configured') setConnectProvider('groq');
          errored = true;
          const msg = reason || 'Sorry, I couldn’t answer that right now. Please try again.';
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: msg, pending: false, tool: null } : x)));
        },
        onError: (msg) => {
          errored = true;
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: msg, pending: false, tool: null } : x)));
        },
      },
      () => stopRef.current,
    );

    const { body, suggestions: sugg } = parseSuggestions(acc);
    if (acc.trim()) {
      setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: body, pending: false, tool: null } : x)));
      setSuggestions(sugg);
    } else if (!errored) {
      // No text and no error surfaced — show a gentle fallback instead of an empty bubble.
      setMessages((m) =>
        m.map((x) =>
          x.id === aiId ? { ...x, content: 'I didn’t get a response — please try again.', pending: false, tool: null } : x,
        ),
      );
    }
    setStreaming(false);

    // Persist the turn to the offline cache + float the session to the top of the sidebar.
    const completedAt = new Date().toISOString();
    const turn: HistoryMessage[] = [{ id: userMsgId, role: 'user', content, createdAt: startedAt }];
    if (body.trim()) {
      turn.push({ id: aiId, role: 'assistant', content: body, createdAt: completedAt, model: usedModel });
    }
    void appendCachedMessages(scope, threadId, turn);
    touchThread(threadId, { updatedAt: completedAt });

    // First turn of a new session → generate a short summary title (Claude-style) and apply it.
    if (isNewSession && body.trim()) {
      const tid = threadId;
      void generateTitle(apiRef.current, tid).then((updated) => {
        if (updated?.title) touchThread(tid, { title: updated.title, updatedAt: updated.updatedAt });
      });
    }
  }

  function pick(s: string) {
    if (/^connect\b/i.test(s)) {
      navigate('/integrations');
      return;
    }
    void send(s);
  }

  if (loadingStatus) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Gate: the agent's model needs at least one BYO LLM provider (Groq or Gemini).
  if (!llmOk) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md animate-fade-in-up text-center">
          <div className="mb-6 flex justify-center">
            <Logo size="lg" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Connect a model to start</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            Your business agent runs on your own free LLM key (stored securely in Portkey). Connect Groq or
            Gemini to begin — add both and the agent rolls across them automatically.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={() => setConnectProvider('groq')}>Connect Groq</Button>
            <Button onClick={() => setConnectProvider('gemini')}>Connect Gemini</Button>
            <Button variant="secondary" onClick={() => navigate('/integrations')}>
              All integrations
            </Button>
          </div>
        </div>
        <ProviderConnect
          open={connectProvider !== null}
          onClose={() => setConnectProvider(null)}
          config={PROVIDER_CONNECT_CONFIGS[connectProvider ?? 'groq']}
          onConnect={async (apiKey) => {
            const r = await api(`/svc/v1/me/integrations/llm/${connectProvider ?? 'groq'}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey }),
            });
            if (!r.ok) {
              throw new Error(await apiErrorMessage(r, `Connect failed (${r.status}).`));
            }
            setConnectProvider(null);
            await refreshStatus(true);
          }}
        />
      </div>
    );
  }

  const showEmpty = !loadingHistory && messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
          {loadingOlder ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}

          {showEmpty && isNotificationsThread ? (
            <div className="flex animate-fade-in flex-col items-center pt-10 text-center text-muted-foreground sm:pt-16">
              <Sparkles className="h-10 w-10" />
              <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                No active-agent messages yet
              </h1>
              <p className="mt-2 text-[15px]">
                Order and event updates from your connected shops appear here — and you can reply to ask the
                agent for details.
              </p>
            </div>
          ) : showEmpty ? (
            <div className="flex animate-fade-in flex-col items-center pt-10 text-center sm:pt-16">
              <ChatEmptyArt className="h-20 w-20" />
              <h1 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">
                How can I help with your business?
              </h1>
              <p className="mt-2 text-[15px] text-muted-foreground">
                Ask about orders, products, fulfillment, and your connected shops.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((e) => (
                  <button
                    key={e}
                    onClick={() => void send(e)}
                    className="rounded-full border bg-background px-3.5 py-2 text-sm text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ) : loadingHistory && messages.length === 0 ? (
            <div className="flex justify-center pt-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((m) => (
                <div key={m.id} className="flex flex-col gap-2">
                  <MessageBubble message={m} />
                  {m.transient ? (
                    <button
                      onClick={() => navigate(`/c/${notifThreadId}`)}
                      className="ml-11 self-start rounded-full border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      Reply in Active Agent →
                    </button>
                  ) : null}
                </div>
              ))}
              {!streaming && suggestions.length > 0 ? <Suggestions items={suggestions} onPick={pick} /> : null}
              {error ? <Alert tone="error">{error}</Alert> : null}
            </div>
          )}
        </div>
      </div>
      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void send(input)}
        onStop={() => {
          stopRef.current = true;
          setStreaming(false);
        }}
        streaming={streaming}
        onConfig={isNotificationsThread ? () => setAutomationOpen(true) : undefined}
      />
      <Modal
        open={automationOpen}
        onClose={() => setAutomationOpen(false)}
        title="Active Agent settings"
        subtitle="Automatic analysis + stock/price sync across your stores."
      >
        <div className="flex flex-col gap-6">
          <AutopilotSettings />
          <div className="border-t pt-6">
            <InsightSettings />
          </div>
          <div className="border-t pt-6">
            <FinanceSettings onChange={setFinanceEnabled} />
          </div>
          {financeEnabled ? (
            <div className="border-t pt-6">
              <TaxSettings />
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
