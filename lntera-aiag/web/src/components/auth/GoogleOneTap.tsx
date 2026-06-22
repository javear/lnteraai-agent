import { useEffect, useRef } from 'react';
import { useAuth } from '../../auth';
import { getPublicConfig } from '../../lib/supabase';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface GsiId {
  initialize: (cfg: Record<string, unknown>) => void;
  prompt: () => void;
  cancel: () => void;
}

function gsiId(): GsiId | null {
  const g = (window as unknown as { google?: { accounts?: { id?: GsiId } } }).google;
  return g?.accounts?.id ?? null;
}

/** Load the Google Identity Services script once (resolves immediately if already present). */
function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (gsiId()) return resolve();
    const prior = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (prior) {
      prior.addEventListener('load', () => resolve(), { once: true });
      prior.addEventListener('error', () => reject(new Error('GIS failed to load')), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new Error('GIS failed to load')), { once: true });
    document.head.appendChild(s);
  });
}

/** A random nonce + its SHA-256 hex. Google signs the HASH into the credential; Supabase verifies it
 *  against the RAW nonce we pass to signInWithIdToken. */
async function makeNonce(): Promise<{ nonce: string; hashed: string }> {
  const toHex = (buf: ArrayBuffer | Uint8Array) =>
    Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hashed = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)));
  return { nonce, hashed };
}

/**
 * Google One Tap — shows the user's Google account automatically (a floating prompt) for one-tap
 * sign-in, with no popup and no redirect. Renders nothing visible (Google draws its own overlay).
 *
 * It is a safe no-op unless BOTH are true: `googleClientId` is configured (set `GOOGLE_CLIENT_ID` on
 * the backend → surfaced via /svc/v1/public-config) AND the user is signed out. The regular
 * "Continue with Google" button remains the manual fallback when One Tap is dismissed/unavailable.
 *
 * Config required for it to actually sign in: the SAME Google **Web** client id must be listed in
 * Supabase → Auth → Google → "Authorized Client IDs", otherwise signInWithIdToken rejects the token.
 */
export function GoogleOneTap() {
  const { supabase, session } = useAuth();
  const clientId = getPublicConfig()?.googleClientId ?? null;
  const startedRef = useRef(false);

  useEffect(() => {
    if (!clientId || session || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        await loadGis();
        const id = gsiId();
        if (cancelled || !id) return;
        const { nonce, hashed } = await makeNonce();
        id.initialize({
          client_id: clientId,
          nonce: hashed,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true,
          callback: (resp: { credential?: string }) => {
            if (!resp?.credential) return;
            void supabase.auth
              .signInWithIdToken({ provider: 'google', token: resp.credential, nonce })
              .then(({ error }) => {
                // On success, onAuthStateChange signs the app in — no redirect, no popup, no reload.
                if (error && import.meta.env.DEV) console.warn('[one-tap] sign-in failed:', error.message);
              });
          },
        });
        id.prompt();
      } catch (err) {
        // Network/CSP/unsupported — silently fall back to the button. Never break the auth page.
        if (import.meta.env.DEV) console.warn('[one-tap] disabled:', err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        gsiId()?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [clientId, session, supabase]);

  return null;
}
