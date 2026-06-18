import { Sparkles } from 'lucide-react';
import { Avatar, TypingDots } from '../../ui';
import { parseSuggestions } from '../../lib/chat';
import type { NotificationAction, NotificationContextRef } from '../../lib/notifications';
import type { ChartSpec } from '../../lib/insights';
import { Markdown } from './Markdown';
import { NotificationActions } from './NotificationActions';
import { InsightChart } from './InsightChart';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp when persisted (absent for in-flight optimistic turns). */
  createdAt?: string;
  /** Assistant turn opened but no text yet (show typing dots). */
  pending?: boolean;
  /** Tool the agent is currently invoking, shown as a subtle activity line. */
  tool?: string | null;
  /** Agent-initiated message surfaced live (not a reply to the user). */
  proactive?: boolean;
  /** A heads-up shown in a non-home chat — rendered but never cached/persisted to that thread. */
  transient?: boolean;
  /** "Provider · model" that produced this answer (live turns only; absent on history reload). */
  model?: string;
  /** Token-free product-sync action buttons (deterministic notifications). */
  actions?: NotificationAction[];
  contextRef?: NotificationContextRef;
  /** Charts for scheduled business-insight messages. */
  charts?: ChartSpec[];
}

/** Localized "when it arrived": time only if today, else date + time (year only if not this year). */
function formatMessageTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  if (d.toDateString() === now.toDateString()) return time;
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(d);
  return `${date}, ${time}`;
}

function ToolActivity({ tool }: { tool: string }) {
  return (
    <div className="mb-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1 w-1 animate-pulse rounded-full bg-brand" />
      Using {tool}…
    </div>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const timeLabel = formatMessageTime(message.createdAt);
  if (message.role === 'user') {
    return (
      <div className="flex animate-fade-in flex-col items-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground [overflow-wrap:anywhere]">
          {message.content}
        </div>
        {timeLabel ? <div className="mt-1 px-1 text-[11px] text-muted-foreground/70">{timeLabel}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex animate-fade-in gap-3">
      <Avatar label="AI" />
      <div className="min-w-0 flex-1 pt-0.5">
        {message.proactive ? (
          <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--brand)/0.12)] px-2 py-0.5 text-[11px] font-medium text-brand">
            <Sparkles className="h-3 w-3" />
            Active Agent
          </div>
        ) : null}
        {message.tool ? <ToolActivity tool={message.tool} /> : null}
        {message.content ? (
          // Strip the trailing ```suggest [...]``` block — its items render as chips, never raw text.
          // (Live messages are already stripped; this covers history/cache reloads.)
          <Markdown>{parseSuggestions(message.content).body}</Markdown>
        ) : message.pending ? (
          <TypingDots />
        ) : null}
        {message.charts && message.charts.length > 0 ? <InsightChart charts={message.charts} /> : null}
        {message.actions && message.actions.length > 0 ? (
          <NotificationActions actions={message.actions} contextRef={message.contextRef} />
        ) : null}
        {timeLabel && (message.content || (message.charts?.length ?? 0) > 0) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground/70">
            <span>{timeLabel}</span>
            {message.model && message.content ? <span className="font-mono">{message.model}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
