// Native (Capacitor) App Links handler. When an installed + verified app opens an https://lntera.ai
// OAuth-return URL, Android routes it here via @capacitor/app's `appUrlOpen` instead of the browser.
// We dismiss the OAuth tab, complete the Supabase PKCE session (Google / recovery carry `?code=`), and
// route into the app via the hash router so marketplace returns land on /integrations. No-op on web.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { IS_NATIVE } from '../lib/runtime';
import { useAuth } from '../auth';

const APP_LINK_HOST = 'lntera.ai';

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
        if (parsed.host !== APP_LINK_HOST) return;

        // Dismiss the in-app OAuth tab (no-op if it isn't open).
        await Browser.close().catch(() => {});

        // Supabase PKCE return (Google sign-in, password recovery) → finish the session in-app. The
        // code verifier was stored in this webview's storage when signInWithOAuth was called.
        const code = parsed.searchParams.get('code');
        if (code) {
          try {
            await supabase.auth.exchangeCodeForSession(code);
          } catch {
            /* a failed exchange just leaves the user signed-out; the session state drives the UI */
          }
        }

        // Route into the app (hash router). Keep the query so /integrations can show its connect toast;
        // strip the now-consumed auth `code` from login/reset returns.
        if (code) {
          navigate(parsed.pathname || '/', { replace: true });
        } else {
          navigate(`${parsed.pathname}${parsed.search}` || '/', { replace: true });
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
