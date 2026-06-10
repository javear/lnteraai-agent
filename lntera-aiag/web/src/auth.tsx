import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { apiUrl } from './lib/runtime';

interface AuthContextValue {
  supabase: SupabaseClient;
  session: Session | null;
  loading: boolean;
  /** Authenticated fetch — attaches the current Supabase access token as a Bearer header. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  signInPassword: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, workspaceName?: string) => Promise<void>;
  signInGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <SessionProvider>');
  return ctx;
}

function tenantIdOf(session: Session | null): string | undefined {
  return (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
}

export function SessionProvider({
  supabase,
  children,
}: {
  supabase: SupabaseClient;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const provisioning = useRef(false);

  // First sign-in for a user with no workspace yet (esp. Google): create one server-side,
  // then refresh the token so it carries app_metadata.tenant_id.
  async function ensureProvisioned(s: Session | null) {
    if (!s || tenantIdOf(s) || provisioning.current) return;
    provisioning.current = true;
    try {
      const res = await fetch(apiUrl('/auth/provision'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: s.access_token }),
      });
      if (res.ok) {
        const { data } = await supabase.auth.refreshSession();
        if (data.session) setSession(data.session);
      }
    } finally {
      provisioning.current = false;
    }
  }

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
      await ensureProvisioned(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      void ensureProvisioned(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      supabase,
      session,
      loading,
      api: (path, init = {}) => {
        const headers = new Headers(init.headers);
        const token = session?.access_token;
        if (token) headers.set('Authorization', `Bearer ${token}`);
        return fetch(apiUrl(path), { ...init, headers });
      },
      signInPassword: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      signUp: async (email, password, workspaceName) => {
        const res = await fetch(apiUrl('/auth/signup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, workspaceName }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(d.message || d.error || `Sign up failed (${res.status}).`);
        }
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      signInGoogle: async () => {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          // BASE_URL ends with '/', so this is `${origin}/app/login` (monolith) or `${origin}/login` (Vercel).
          options: { redirectTo: `${location.origin}${import.meta.env.BASE_URL}login` },
        });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [supabase, session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
