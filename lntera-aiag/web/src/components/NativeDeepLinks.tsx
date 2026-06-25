// Native (Capacitor) deep-link handler. Android routes inbound links here via @capacitor/app's
// `appUrlOpen`. We accept two shapes:
//   • custom scheme  com.lntera.app://login|reset-password|integrations[?…]   (OAuth return — reliable
//     handoff from the Custom Tab, no assetlinks/signing dependency)
//   • https App Link https://lntera.ai/login|reset-password|integrations[?…]  (when verified)
// We dismiss the OAuth tab, complete the Supabase PKCE session (Google / recovery carry `?code=`), and
// route into the app via the hash router. No-op on web.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { IS_NATIVE } from '../lib/runtime';
import { useAuth } from '../auth';

const APP_LINK_HOST = 'lntera.ai';
const CUSTOM_SCHEME = 'com.lntera.app';

export function NativeDeepLinks() {
  const { supabase } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!IS_NATIVE) return;
    let remove: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ App }, { Browser }] = await Promise.all([import('@capacitor/app'), import('@capacitor/browser')]);
      if (cancelled) return;
      const handle = await App.addListener('appUrlOpen', async ({ url }) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        const isScheme = parsed.protocol === `${CUSTOM_SCHEME}:`;
        if (!isScheme && parsed.host !== APP_LINK_HOST) return;

        // Dismiss the in-app OAuth tab (no-op if it isn't open).
        await Browser.close().catch(() => {});

        // The destination: for the custom scheme it's the host segment (com.lntera.app://login → "login");
        // for the App Link it's the path (https://lntera.ai/login → "login").
        const target = (isScheme ? parsed.host : parsed.pathname.replace(/^\/+/, '')).replace(/\/+$/, '');

        // Supabase PKCE return (Google sign-in, password recovery) carries `?code=` → finish the session
        // in-app (the verifier was stored in this webview when signInWithOAuth was called).
        const code = parsed.searchParams.get('code');
        if (code) {
          try {
            await supabase.auth.exchangeCodeForSession(code);
          } catch {
            /* a failed exchange just leaves the user signed-out; the session state drives the UI */
          }
          // Recovery → its form (also enforced by RecoveryRedirect); any other sign-in → home.
          navigate(target.startsWith('reset-password') ? '/reset-password' : '/', { replace: true });
        } else {
          // Non-auth deep link (e.g. marketplace connect return) → keep the query for the page's toast.
          navigate(`/${target}${parsed.search}`, { replace: true });
        }
      });
      remove = () => void handle.remove();
    })();

    return () => {
      cancelled = true;
      remove?.();
    };
  }, [supabase, navigate]);

  return null;
}
