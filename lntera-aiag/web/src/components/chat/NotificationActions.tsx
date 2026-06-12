import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { postResync, postSyncAction } from '../../lib/product-sync-actions';
import type { NotificationAction, NotificationContextRef } from '../../lib/notifications';

/**
 * Token-free interactive buttons for a product-sync prompt. Clicks go straight to REST endpoints
 * (never the agent), then collapse to a one-line confirmation. Idempotent: re-clicking a decided
 * link just returns "Already …" from the server.
 */
export function NotificationActions({
  actions,
  contextRef,
}: {
  actions: NotificationAction[];
  contextRef?: NotificationContextRef;
}) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string } | null>(null);

  if (!actions || actions.length === 0) return null;

  async function onClick(a: NotificationAction) {
    if (done || busy) return;

    if (a.kind === 'dismiss') {
      setDone({ message: '' });
      return;
    }
    if (a.kind === 'link' || a.kind === 'list_on_marketplace') {
      if (a.href) navigate(a.href);
      setDone({ message: '' });
      return;
    }

    setBusy(a.id);
    try {
      if (a.kind === 'resync') {
        const r = await postResync(api, { platform: contextRef?.platform, mode: a.id });
        setDone({ message: r.message });
      } else {
        // sync_action — needs the mapping link id.
        if (!contextRef?.linkId) {
          setDone({ message: 'This item is no longer available.' });
          return;
        }
        const r = await postSyncAction(api, contextRef.linkId, a.id);
        setDone({ message: r.message });
      }
    } catch {
      setDone({ message: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return done.message ? (
      <div className="mt-2 animate-fade-in text-[13px] text-muted-foreground">{done.message}</div>
    ) : null;
  }

  return (
    <div className="mt-2.5 flex animate-fade-in flex-wrap gap-2">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          onClick={() => onClick(a)}
          className={buttonClass(a.style)}
        >
          {busy === a.id ? 'Working…' : a.label}
        </button>
      ))}
    </div>
  );
}

function buttonClass(style?: string): string {
  const base =
    'rounded-full border px-3.5 py-1.5 text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';
  if (style === 'primary') {
    return `${base} border-transparent bg-[hsl(var(--brand))] text-white hover:opacity-90`;
  }
  if (style === 'danger') {
    return `${base} border-transparent bg-destructive text-destructive-foreground hover:opacity-90`;
  }
  return `${base} bg-background text-foreground hover:bg-accent hover:text-accent-foreground`;
}
