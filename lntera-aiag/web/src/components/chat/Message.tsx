import { Sparkles } from 'lucide-react';
import { Avatar, TypingDots } from '../../ui';
import { parseSuggestions } from '../../lib/chat';
import { Markdown } from './Markdown';

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
}

function ToolActivity({ tool }: { tool: string }) {
  return (
    <div className="mb-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--brand))]" />
      Using {tool}…
    </div>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex animate-fade-in justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground [overflow-wrap:anywhere]">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex animate-fade-in gap-3">
      <Avatar label="AI" />
      <div className="min-w-0 flex-1 pt-0.5">
        {message.proactive ? (
          <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--brand)/0.12)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--brand))]">
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
        {message.model && message.content ? (
          <div className="mt-1.5 font-mono text-[11px] text-muted-foreground/70">{message.model}</div>
        ) : null}
      </div>
    </div>
  );
}
