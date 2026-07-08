import { memo } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { Avatar } from '../../ui';
import { parseSuggestions } from '../../lib/chat';
import { stripReasoning } from '../../lib/reasoning';
import { useT } from '../../i18n';
import type { NotificationAction, NotificationContextRef } from '../../lib/notifications';
import type { ChartSpec } from '../../lib/insights';
import { formatBytes } from '../../lib/knowledge';
import { Markdown } from './Markdown';
import { NotificationActions } from './NotificationActions';
import { InsightChart } from './InsightChart';
import { ThinkingIndicator } from './Thinking';

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
  /** Live reasoning ("thinking") text while streaming — ephemeral, never persisted to content. */
  reasoning?: string;
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
  /** Documents attached via the composer's attach button (already uploaded to the knowledge base). */
  attachments?: { name: string; size: number }[];
}

function AttachmentChips({ attachments }: { attachments: { name: string; size: number }[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((a, i) => (
        <div
          key={`${a.name}-${i}`}
          className="flex max-w-[220px] items-center gap-1.5 rounded-lg border bg-background/80 px-2.5 py-1.5 text-[12px] text-foreground shadow-sm"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
        </div>
      ))}
    </div>
  );
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

function MessageBubbleImpl({ message }: { message: ChatMessage }) {
  const t = useT();
  const timeLabel = formatMessageTime(message.createdAt);
  if (message.role === 'user') {
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    return (
      <div className="flex animate-fade-in flex-col items-end gap-1.5">
        {hasAttachments ? <AttachmentChips attachments={message.attachments!} /> : null}
        {message.content ? (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground [overflow-wrap:anywhere]">
            {message.content}
          </div>
        ) : null}
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
        {(() => {
          // Strip the trailing ```suggest``` block + any inline reasoning that slipped into content.
          const body = message.content ? parseSuggestions(stripReasoning(message.content)).body : '';
          if (body) return <Markdown>{body}</Markdown>;
          // No content yet → show the live "thinking" state (tool action, reasoning preview, or rotating
          // words). Ephemeral: once content streams in, this is gone — reasoning never joins the content.
          const working = message.pending || message.tool || (message.reasoning?.trim().length ?? 0) > 0;
          if (working)
            return (
              <ThinkingIndicator
                reasoning={message.reasoning}
                label={message.tool ? t('thinking.tool', { tool: message.tool }) : undefined}
              />
            );
          return null;
        })()}
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

// Memoized: during streaming only the changing message re-renders (not the whole list), and a
// settled message never re-renders/re-parses its markdown when a new turn streams in.
export const MessageBubble = memo(MessageBubbleImpl);
