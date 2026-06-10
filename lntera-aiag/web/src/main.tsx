import { StrictMode, Suspense, lazy, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import { BootSplashArt } from './components/Lottie';
import './index.css';

// Route chunks load on demand — Login never pulls in the chat SDK/markdown bundles.
const Login = lazy(() => import('./pages/Login'));
const Chat = lazy(() => import('./pages/Chat'));
const Integrations = lazy(() => import('./pages/Integrations'));

/** Full-screen branded splash for boot/auth gaps (lazy Lottie, falls back to the logo). */
function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <BootSplashArt className="h-16 w-16" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  if (loading) return <BootScreen />;
  if (!session) return <Navigate to="/login" replace />;
  return children;
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
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
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
