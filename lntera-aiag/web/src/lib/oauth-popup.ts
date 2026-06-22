import { API_BASE } from './runtime';

// NOT noopener: the backend result page needs window.opener to postMessage the outcome back.
const POPUP_FEATURES = 'popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes';

/** Origin that serves our OAuth result page (the backend) — the only origin we trust postMessage from. */
function apiOrigin(): string {
  try {
    return API_BASE ? new URL(API_BASE).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

export interface OAuthPopupResult {
  status: 'ok' | 'error';
  message?: string | null;
}

export interface OpenAuthPopupHandle {
  /** false when the browser blocked the popup — the caller should fall back to a full-page redirect. */
  opened: boolean;
}

/**
 * Open an OAuth/connect URL in a popup (desktop) / new tab (mobile) so the SPA never unloads.
 *
 * The backend result page postMessages the outcome back (see server html-pages `oauthBridgeScript`)
 * and closes itself on success; we also detect the window being closed without a result (cancel).
 * On mobile, postMessage/auto-close may not fire — so callers should ALSO refresh on the realtime
 * `connection` event as the backstop. Returns `{ opened: false }` if the popup was blocked.
 */
export function openAuthPopup(
  url: string,
  handlers: { onResult?: (r: OAuthPopupResult) => void; onClose?: () => void } = {},
): OpenAuthPopupHandle {
  const win = window.open(url, 'lntera_oauth', POPUP_FEATURES);
  if (!win) return { opened: false };

  const expectedOrigin = apiOrigin();
  let settled = false;
  let pollId: number | undefined;

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    if (pollId) window.clearInterval(pollId);
  };

  function onMessage(e: MessageEvent) {
    if (e.origin !== expectedOrigin) return;
    const d = e.data as { source?: string; status?: unknown; message?: unknown } | null;
    if (!d || d.source !== 'lntera-oauth' || (d.status !== 'ok' && d.status !== 'error')) return;
    if (settled) return;
    settled = true;
    cleanup();
    handlers.onResult?.({ status: d.status, message: typeof d.message === 'string' ? d.message : null });
  }

  window.addEventListener('message', onMessage);

  // Detect the user closing the window without finishing (cancel). The result handler wins if a
  // message arrived first (settled guard), so a successful auto-close won't fire onClose.
  pollId = window.setInterval(() => {
    if (win.closed && !settled) {
      settled = true;
      cleanup();
      handlers.onClose?.();
    }
  }, 700);

  return { opened: true };
}
