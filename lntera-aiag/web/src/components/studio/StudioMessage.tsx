import { memo } from 'react';
import { Avatar } from '@/ui';
import { parseSuggestions } from '@/lib/chat';
import { stripReasoning } from '@/lib/reasoning';
import { Markdown } from '../chat/Markdown';
import { ThinkingIndicator } from '../chat/Thinking';
import { StudioActivityTimeline } from './StudioActivity';
import type { StudioActivity } from '@/lib/studio/activity';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** A Studio chat turn — like the business ChatMessage but carrying the inline activity timeline. */
export interface StudioChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  /** Assistant turn opened but nothing has streamed yet → show typing dots. */
  pending?: boolean;
  /** "Provider · model" that produced this turn (live turns only). */
  model?: string;
  /** Ordered inline timeline: file writes, terminal commands, git actions, thoughts. */
  activity: StudioActivity[];
}

function StudioMessageBubbleImpl({
  message,
  api,
  projectId,
  onSecretSaved,
}: {
  message: StudioChatMessage;
  /** Needed only for a live turn's studio-request-secret card to submit the secret it collects.
   *  Omitted for read-only history renders (secret-request activity is never rehydrated anyway — see
   *  the comment on the history-load effect in Studio.tsx). */
  api?: Api;
  projectId?: string;
  onSecretSaved?: (name: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex animate-fade-in flex-col items-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground [overflow-wrap:anywhere]">
          {message.content}
        </div>
      </div>
    );
  }

  const body = message.content ? parseSuggestions(stripReasoning(message.content)).body : '';
  // Show the "waiting" dots only before anything at all has arrived (no activity, no text yet).
  const showDots = message.pending && message.activity.length === 0 && !body;

  return (
    <div className="flex animate-fade-in gap-3">
      <Avatar label="AI" />
      <div className="min-w-0 flex-1 pt-0.5">
        <StudioActivityTimeline activity={message.activity} api={api} projectId={projectId} onSecretSaved={onSecretSaved} />
        {body ? <Markdown>{body}</Markdown> : null}
        {showDots ? <ThinkingIndicator /> : null}
        {message.model && body ? (
          <div className="mt-1.5 text-[11px] font-mono text-muted-foreground/70">{message.model}</div>
        ) : null}
      </div>
    </div>
  );
}

// Memoized so only the streaming message re-renders as its activity/content mutate.
export const StudioMessageBubble = memo(StudioMessageBubbleImpl);
