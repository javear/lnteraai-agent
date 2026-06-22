import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { IS_NATIVE } from './lib/runtime';
import { fetchPublicConfig, makeSupabase } from './lib/supabase';
import { SessionProvider, useAuth } from './auth';
import { ThemeProvider } from './theme';
import { Toaster } from '@/components/ui/sonner';
import { PwaUpdater } from './components/PwaUpdater';
import { Button, Centered } from './ui';
import { AppLayout } from './components/AppLayout';
import { ChatRouteSkeleton, PageRouteSkeleton } from './components/Skeletons';
import { Logo } from './ui';
import './index.css';

// Route chunks load on demand — Login never pulls in the chat SDK/markdown bundles.
const Login = lazy(() => import('./pages/Login'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Chat = lazy(() => import('./pages/Chat'));
const Integrations = lazy(() => import('./pages/Integrations'));
// Marketing landing — web only. Gated on the BUILD mode (not the runtime IS_NATIVE) so Rollup
// dead-code-eliminates the dynamic import: the chunk never ships in the native (Capacitor) bundle.
const Landing = import.meta.env.MODE === 'native' ? null : lazy(() => import('./pages/Landing'));

// Chat is the default authed landing; warm its chunk while the network is idle during the auth
// round-trip so the most common entry doesn't wait on a serial fetch behind the boot splash.
if (!IS_NATIVE && typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  requestIdleCallback(() => {
    void import('./pages/Chat');
  });
}

/** Full-screen branded splash for boot/auth gaps — the static brand mark (no heavy Lottie/WASM). */
function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Logo size="lg" wordmark={false} className="opacity-90 motion-safe:animate-fade-in" />
    </div>
  );
}

/**
 * Index gate for the app shell. Logged-out visitors see the marketing landing at "/" and are
 * bounced to the focused /login for any deeper route; authed users get the normal app layout
 * (whose <Outlet/> renders the matched child route — Chat or Integrations).
 */
function AppGate() {
  const { session, loading } = useAuth();
  const isHome = useMatch({ path: '/', end: true }) != null;
  if (loading) return <BootScreen />;
  if (!session) {
    if (isHome && Landing) {
      return (
        <Suspense fallback={<BootScreen />}>
          <Landing />
        </Suspense>
      );
    }
    return <Navigate to="/login" replace />;
  }
  return <AppLayout />;
}

/** Force a password-recovery session to the reset form, wherever Supabase's link happened to land
 *  (Site URL fallback, /login, etc.) — so a recovery link never silently logs the user into the app. */
function RecoveryRedirect() {
  const { recovery } = useAuth();
  const navigate = useNavigate();
  const onReset = useMatch({ path: '/reset-password', end: true }) != null;
  useEffect(() => {
    if (recovery && !onReset) navigate('/reset-password', { replace: true });
  }, [recovery, onReset, navigate]);
  return null;
}

/** Popup-callback for Google SSO. Supabase finalizes the session here (detectSessionInUrl), then this
 *  popup notifies its opener and closes — the opener tab signs in via Supabase's cross-tab session sync.
 *  If the popup was blocked (this loaded in the same tab via a full redirect), it just enters the app. */
function AuthPopupCallback() {
  const { session } = useAuth();
  useEffect(() => {
    const inPopup = typeof window !== 'undefined' && !!window.opener && window.opener !== window;
    const finish = (status: 'ok' | 'error') => {
      if (inPopup) {
        try {
          window.opener!.postMessage({ source: 'lntera-oauth', status }, window.location.origin);
        } catch {
          /* cross-origin opener — the cross-tab session sync still signs the app in */
        }
        window.close();
      } else {
        window.location.replace(import.meta.env.BASE_URL || '/');
      }
    };
    if (session) {
      finish('ok');
      return;
    }
    // No session yet — detectSessionInUrl is still exchanging the code. Give up after a grace period.
    const t = window.setTimeout(() => finish('error'), 8000);
    return () => window.clearTimeout(t);
  }, [session]);
  return <BootScreen />;
}

function Boot() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // fetchPublicConfig already retries with backoff and falls back to a cached config; it only rejects
  // when there's truly no network AND no cache. In that case we show a retry screen (not a dead-end),
  // and bumping `attempt` re-runs the whole resilient fetch.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchPublicConfig()
      .then((cfg) => {
        if (!cancelled) setSupabase(makeSupabase(cfg));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (error)
    return (
      <Centered>
        <div className="flex max-w-xs flex-col items-center gap-4 text-center">
          <Logo size="lg" wordmark={false} className="opacity-90" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      </Centered>
    );
  if (!supabase) return <BootScreen />;

  return (
    <SessionProvider supabase={supabase}>
      <RecoveryRedirect />
      <Routes>
        <Route
          path="/login"
          element={
            <Suspense fallback={<BootScreen />}>
              <Login />
            </Suspense>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <Suspense fallback={<BootScreen />}>
              <ForgotPassword />
            </Suspense>
          }
        />
        <Route
          path="/reset-password"
          element={
            <Suspense fallback={<BootScreen />}>
              <ResetPassword />
            </Suspense>
          }
        />
        <Route path="/auth/popup" element={<AuthPopupCallback />} />
        <Route element={<AppGate />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<ChatRouteSkeleton />}>
                <Chat />
              </Suspense>
            }
          />
          <Route
            path="/c/:threadId"
            element={
              <Suspense fallback={<ChatRouteSkeleton />}>
                <Chat />
              </Suspense>
            }
          />
          <Route
            path="/integrations"
            element={
              <Suspense fallback={<PageRouteSkeleton />}>
                <Integrations />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}

// Web uses history routing under the Vite `base` (/app for the Mastra monolith, / for Vercel).
// Native shells load from file://capacitor — use hash routing (no server to resolve deep paths)
// and skip the service worker entirely.
const Router = IS_NATIVE ? HashRouter : BrowserRouter;
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';
const routerProps = IS_NATIVE ? {} : { basename };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Router {...routerProps}>
        <Boot />
      </Router>
      <Toaster />
      {!IS_NATIVE ? <PwaUpdater /> : null}
    </ThemeProvider>
  </StrictMode>,
);
