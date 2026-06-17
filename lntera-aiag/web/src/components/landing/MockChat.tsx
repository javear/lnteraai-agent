import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '../../lib/useReducedMotion';

type Msg = {
  role: 'user' | 'assistant';
  text: string;
  typing?: boolean;
  thinking?: boolean;
  tool?: string;
};

// Scripted demo using the app's real example prompts + tool names. No API calls.
const SCRIPT: { prompt: string; tool: string; reply: string }[] = [
  {
    prompt: "Show today's orders",
    tool: 'search-orders',
    reply:
      'You have 12 orders today across 2 shops. 3 are ready to ship — want me to create the fulfillment packages?',
  },
  {
    prompt: 'Search my products',
    tool: 'search-products',
    reply: '48 active products. "Linen Shirt — Beige" is low on stock (4 left). Want me to update it?',
  },
];

const STATIC_VIEW: Msg[] = [
  { role: 'user', text: SCRIPT[0].prompt },
  { role: 'assistant', text: SCRIPT[0].reply, tool: SCRIPT[0].tool },
];

const MAX_VISIBLE = 4;
const cap = (m: Msg[]) => (m.length > MAX_VISIBLE ? m.slice(m.length - MAX_VISIBLE) : m);

function patchLast(m: Msg[], patch: Partial<Msg>): Msg[] {
  if (m.length === 0) return m;
  const next = m.slice();
  next[next.length - 1] = { ...next[next.length - 1], ...patch };
  return next;
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5" aria-label="thinking">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[hsl(var(--fg-soft))] [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[hsl(var(--fg-soft))] [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[hsl(var(--fg-soft))]" />
    </span>
  );
}

/** Calm, clean demo of chatting with the agent — typed prompt → tool → reply, slow loop. */
export function MockChat({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [messages, setMessages] = useState<Msg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    const timers: number[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        timers.push(window.setTimeout(res, ms));
      });

    async function run() {
      let i = 0;
      setMessages([]);
      while (!cancelled) {
        const item = SCRIPT[i % SCRIPT.length];
        setMessages((m) => cap([...m, { role: 'user', text: '', typing: true }]));
        for (let c = 1; c <= item.prompt.length; c++) {
          if (cancelled) return;
          setMessages((m) => patchLast(m, { text: item.prompt.slice(0, c) }));
          await sleep(42);
        }
        setMessages((m) => patchLast(m, { typing: false }));
        await sleep(500);
        setMessages((m) => cap([...m, { role: 'assistant', text: '', thinking: true, tool: item.tool }]));
        await sleep(1700);
        setMessages((m) => patchLast(m, { text: item.reply, thinking: false }));
        await sleep(3400);
        i += 1;
        if (i % SCRIPT.length === 0) {
          await sleep(400);
          if (cancelled) return;
          setMessages([]);
          await sleep(400);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
    };
  }, [reduced]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const view = reduced ? STATIC_VIEW : messages;

  return (
    <div
      role="img"
      aria-label="Demo of chatting with the Lntera agent about orders and products"
      className={cn('lp-frame flex h-[clamp(360px,46vh,440px)] w-full flex-col overflow-hidden', className)}
    >
      {/* header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="lp-mono text-[11px] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
          Lntera agent
        </span>
        <span className="lp-mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[hsl(var(--fg-soft))]">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          online
        </span>
      </div>

      {/* transcript */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
        {view.map((m, idx) =>
          m.role === 'user' ? (
            <div
              key={idx}
              className="ml-auto max-w-[82%] rounded-2xl rounded-br-md bg-[hsl(var(--bg-3))] px-3.5 py-2 text-[13.5px] leading-relaxed text-[hsl(var(--fg))]"
            >
              {m.text}
              {m.typing ? <span className="lp-caret h-3.5" /> : null}
            </div>
          ) : (
            <div key={idx} className="max-w-[90%]">
              {m.tool ? (
                <div className="lp-mono mb-1.5 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[hsl(var(--fg-soft))]">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full bg-brand',
                      m.thinking && 'animate-pulse',
                    )}
                  />
                  {m.thinking ? `running ${m.tool}…` : m.tool}
                </div>
              ) : null}
              <div className="rounded-2xl rounded-bl-md border-l-2 border-brand bg-[hsl(var(--bg))] px-3.5 py-2 text-[13.5px] leading-relaxed text-[hsl(var(--fg))]">
                {m.thinking && !m.text ? <Dots /> : m.text}
              </div>
            </div>
          ),
        )}
      </div>

      {/* composer — visual only; the agent-cursor "clicks" here */}
      <div className="shrink-0 border-t px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-full border bg-[hsl(var(--bg-2))] px-3.5 py-2">
          <span className="flex-1 truncate text-[12.5px] text-[hsl(var(--fg-soft))]">Ask your shops anything…</span>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 19V5M5 12l7-7 7 7"
                stroke="hsl(var(--brand-foreground))"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
