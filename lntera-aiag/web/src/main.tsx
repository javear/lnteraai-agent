import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useMatch } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { IS_NATIVE } from './lib/runtime';
import { fetchPublicConfig, makeSupabase } from './lib/supabase';
import { SessionProvider, useAuth } from './auth';
import { ThemeProvider } from './theme';
import { Toaster } from '@/components/ui/sonner';
import { PwaUpdater } from './components/PwaUpdater';
import { Centered } from './ui';
import { AppLayout } from './components/AppLayout';
import { ChatRouteSkeleton, PageRouteSkeleton } from './components/Skeletons';
import { Logo } from './ui';
import './index.css';

// Route chunks load on demand — Login never pulls in the chat SDK/markdown bundles.
const Login = lazy(() => import('./pages/Login'));
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

function Boot() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicConfig()
      .then((cfg) => setSupabase(makeSupabase(cfg)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Centered>{error}</Centered>;
  if (!supabase) return <BootScreen />;

  return (
    <SessionProvider supabase={supabase}>
      <Routes>
        <Route
          path="/login"
          element={
            <Suspense fallback={<BootScreen />}>
              <Login />
            </Suspense>
          }
        />
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
