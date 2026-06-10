import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Avatar, TypingDots } from '../../ui';
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
    reply: '48 active products. “Linen Shirt — Beige” is low on stock (4 left). Want me to update it?',
  },
  {
    prompt: 'List my connected shops',
    tool: 'list-marketplace-shops',
    reply: '2 connected — Shopee · Main Store and TikTok Shop · Outlet.',
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

/** Auto-playing demo of chatting with the agent — typed prompt → "thinking" → reply, looping. */
export function MockChat({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [messages, setMessages] = useState<Msg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return; // static transcript is rendered instead
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
          await sleep(34);
        }
        setMessages((m) => patchLast(m, { typing: false }));
        await sleep(350);
        setMessages((m) => cap([...m, { role: 'assistant', text: '', thinking: true, tool: item.tool }]));
        await sleep(1500);
        setMessages((m) => patchLast(m, { text: item.reply, thinking: false }));
        await sleep(2700);
        i += 1;
        if (i % SCRIPT.length === 0) {
          await sleep(250);
          if (cancelled) return;
          setMessages([]);
          await sleep(300);
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
      className={cn(
        'flex h-[360px] w-full flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm',
        className,
      )}
    >
      {/* Faux window chrome */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary">
          <Sparkles className="h-3 w-3 text-primary-foreground" />
        </span>
        <span className="text-[13px] font-medium">Lntera agent</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          online
        </span>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
        {view.map((m, idx) =>
          m.role === 'user' ? (
            <div
              key={idx}
              className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13.5px] leading-relaxed text-primary-foreground"
            >
              {m.text}
              {m.typing ? <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-primary-foreground align-middle" /> : null}
            </div>
          ) : (
            <div key={idx} className="flex max-w-[92%] items-start gap-2.5">
              <Avatar label="AI" />
              <div className="min-w-0">
                {m.tool ? (
                  <div className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                    <span className={cn('h-1.5 w-1.5 rounded-full', m.thinking ? 'animate-pulse bg-brand' : 'bg-success')} />
                    {m.thinking ? `Using ${m.tool}…` : m.tool}
                  </div>
                ) : null}
                {m.thinking && !m.text ? (
                  <div className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2">
                    <TypingDots />
                  </div>
                ) : (
                  <div className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[13.5px] leading-relaxed text-foreground">
                    {m.text}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
