import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, History, Loader2 } from 'lucide-react';
import { useAuth } from '../../auth';
import {
  getLinkState,
  getProposalState,
  postPropagate,
  postResync,
  postSyncAction,
  type ProposalState,
} from '../../lib/product-sync-actions';
import type { NotificationAction, NotificationContextRef } from '../../lib/notifications';

/**
 * Token-free interactive buttons for a product-sync prompt. Clicks go straight to REST endpoints
 * (never the agent), then collapse to a one-line confirmation.
 *
 * Critically, the buttons reflect the DURABLE server state, not just this session: on (re)load we look
 * up the proposal/mapping and, if it's already decided, dismissed, superseded, or expired, render a
 * static chip instead of fresh buttons — so a prompt you already handled never reappears as clickable,
 * and a stale prompt (replaced by a newer change) says so up front.
 */

type Resolved = { label: string; tone: 'ok' | 'muted' };

// Session cache so re-mounting a thread (scroll/virtualization) doesn't re-flash or re-fetch a prompt
// we've already resolved. 'pending' = actionable.
const stateCache = new Map<string, Resolved | 'pending'>();

function resolveProposal(state: ProposalState): Resolved | 'pending' {
  switch (state) {
    case 'applied':
      return { label: 'Applied', tone: 'ok' };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'muted' };
    case 'superseded':
      return { label: 'Superseded by a newer change', tone: 'muted' };
    case 'expired':
      return { label: 'Expired — make the change again to re-apply', tone: 'muted' };
    case 'pending':
    default:
      return 'pending'; // unknown / not_found → stay actionable; the POST guards on click
  }
}

function resolveLink(s: { actionable: boolean; status: string }): Resolved | 'pending' {
  if (s.actionable) return 'pending';
  switch (s.status) {
    case 'confirmed':
    case 'auto_mapped':
      return { label: 'Linked', tone: 'ok' };
    case 'new_created':
      return { label: 'Added to your catalog', tone: 'ok' };
    case 'ignored':
    case 'rejected':
      return { label: 'Dismissed', tone: 'muted' };
    case 'gone':
      return { label: 'No longer available', tone: 'muted' };
    default:
      return { label: 'Done', tone: 'ok' };
  }
}

/** Optimistic resolved chip for a click, before the server round-trip confirms. */
function resolveSyncChoice(choice: string): Resolved {
  if (choice.startsWith('create')) return { label: 'Added to your catalog', tone: 'ok' };
  if (choice.startsWith('map')) return { label: 'Linked', tone: 'ok' };
  if (choice === 'skip' || choice === 'ignore') return { label: 'Dismissed', tone: 'muted' };
  return { label: 'Done', tone: 'ok' };
}

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
  const [done, setDone] = useState<{ message: string; ok?: boolean } | null>(null);

  const proposalId = contextRef?.proposalId;
  const linkId = contextRef?.linkId;
  const cacheKey = proposalId ? `p:${proposalId}` : linkId ? `l:${linkId}` : null;

  // Durable state. null = not yet known (fetching); 'pending' = actionable; Resolved = show a chip.
  // Actions with no server-side record (resync / link / dismiss-only) are always 'pending'.
  const [state, setState] = useState<Resolved | 'pending' | null>(() =>
    cacheKey ? stateCache.get(cacheKey) ?? null : 'pending',
  );

  useEffect(() => {
    if (!cacheKey || state !== null) return;
    let cancelled = false;
    void (async () => {
      let resolved: Resolved | 'pending' = 'pending';
      if (proposalId) {
        resolved = resolveProposal(await getProposalState(api, proposalId));
      } else if (linkId) {
        const s = await getLinkState(api, linkId);
        resolved = s ? resolveLink(s) : 'pending';
      }
      if (cancelled) return;
      stateCache.set(cacheKey, resolved);
      setState(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, cacheKey, proposalId, linkId, state]);

  if (!actions || actions.length === 0) return null;

  function settle(d: { message: string; ok?: boolean }, terminal?: Resolved) {
    setDone(d);
    if (cacheKey && terminal) stateCache.set(cacheKey, terminal);
  }

  async function onClick(a: NotificationAction) {
    if (done || busy) return;

    if (a.kind === 'link' || a.kind === 'list_on_marketplace') {
      if (a.href) navigate(a.href);
      setDone({ message: '' });
      return;
    }
    // 'dismiss' with no server record (e.g. the resync "Not now") is purely local.
    if (a.kind === 'dismiss' && !proposalId) {
      setDone({ message: 'Dismissed' });
      return;
    }

    setBusy(a.id);
    try {
      if (a.kind === 'resync') {
        const r = await postResync(api, { platform: contextRef?.platform, mode: a.id });
        setDone({ message: r.message, ok: true });
      } else if (a.kind === 'propagate' || a.kind === 'dismiss') {
        // Bidirectional-sync proposal: apply / apply_always / dismiss — all persist server-side.
        if (!proposalId) {
          settle({ message: 'This sync request is no longer available.' }, { label: 'No longer available', tone: 'muted' });
          return;
        }
        const choice = a.kind === 'dismiss' ? 'dismiss' : a.id;
        const r = await postPropagate(api, proposalId, choice);
        settle(
          { message: r.message, ok: r.ok },
          choice === 'dismiss' ? { label: 'Dismissed', tone: 'muted' } : { label: 'Applied', tone: 'ok' },
        );
      } else {
        // sync_action — recognition decision keyed on the mapping link id.
        if (!linkId) {
          settle({ message: 'This item is no longer available.' }, { label: 'No longer available', tone: 'muted' });
          return;
        }
        const r = await postSyncAction(api, linkId, a.id);
        settle({ message: r.message, ok: true }, resolveSyncChoice(a.id));
      }
    } catch {
      setDone({ message: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(null);
    }
  }

  // 1) Acted this session → inline confirmation of the server's response.
  if (done) {
    if (!done.message) return null;
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 animate-fade-in text-[13px] text-muted-foreground">
        {done.ok ? <Check className="h-3.5 w-3.5 text-success" /> : null}
        {done.message}
      </div>
    );
  }

  // 2) Already resolved server-side (decided / dismissed / superseded / expired) → static chip.
  if (state && state !== 'pending') {
    return <ResolvedChip resolved={state} />;
  }

  // 3) Pending (or still loading durable state) → actionable buttons.
  return (
    <div className="mt-2.5 flex animate-fade-in flex-wrap gap-2">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          aria-busy={busy === a.id}
          onClick={() => onClick(a)}
          className={buttonClass(a.style)}
        >
          {busy === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {a.label}
        </button>
      ))}
    </div>
  );
}

function ResolvedChip({ resolved }: { resolved: Resolved }) {
  return (
    <div className="mt-2 inline-flex items-center gap-1.5 animate-fade-in text-[13px] text-muted-foreground">
      {resolved.tone === 'ok' ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <History className="h-3.5 w-3.5 opacity-70" />
      )}
      {resolved.label}
    </div>
  );
}

function buttonClass(style?: string): string {
  const base =
    'inline-flex items-center justify-center rounded-full border px-3.5 py-1.5 text-[13px] font-medium shadow-xs transition-[background-color,color,transform,opacity] duration-150 ease-soft active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';
  if (style === 'primary') {
    return `${base} border-transparent bg-brand text-white hover:bg-brand-hover`;
  }
  if (style === 'danger') {
    return `${base} border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90`;
  }
  return `${base} border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground`;
}
