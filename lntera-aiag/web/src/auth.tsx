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
import { apiUrl, IS_NATIVE } from './lib/runtime';
import { logoutPush } from './lib/push';
import { setTelemetryUser } from './lib/analytics';

/**
 * Native OAuth return target. A CUSTOM SCHEME (not an https App Link) — Chrome Custom Tabs reliably hand
 * a custom scheme back to the app, and it needs no domain/assetlinks verification (works on any signing,
 * incl. CI debug builds). The app registers this scheme in AndroidManifest; the value must also be in the
 * Supabase Auth → Redirect URLs allowlist. NativeDeepLinks handles the inbound `com.lntera.app://…` URL.
 */
const NATIVE_AUTH_SCHEME = 'com.lntera.app';

interface AuthContextValue {
  supabase: SupabaseClient;
  session: Session | null;
  loading: boolean;
  /** Authenticated fetch — attaches the current Supabase access token as a Bearer header. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  signInPassword: (email: string, password: string) => Promise<void>;
  /** Register via Supabase. With email confirmation ON, no session is returned until the emailed
   *  6-digit code is verified → `{ needsConfirmation: true }`. */
  signUp: (email: string, password: string, workspaceName?: string) => Promise<{ needsConfirmation: boolean }>;
  /** Verify the signup confirmation code (type 'signup'). */
  confirmSignup: (email: string, token: string) => Promise<void>;
  /** Re-send the signup confirmation code. */
  resendSignupCode: (email: string) => Promise<void>;
  /** Passwordless login: email a 6-digit code to an EXISTING user (won't create one). */
  sendLoginCode: (email: string) => Promise<void>;
  /** Verify a passwordless login code (type 'email') → establishes the session. */
  verifyLoginCode: (email: string, token: string) => Promise<void>;
  signInGoogle: () => Promise<void>;
  /** Email a password-recovery link that returns to /reset-password. */
  resetPassword: (email: string) => Promise<void>;
  /** Set a new password for the current (recovery or signed-in) session. */
  updatePassword: (password: string) => Promise<void>;
  /** True between a PASSWORD_RECOVERY event and setting a new password — gates the app so a recovery
   *  link opens the reset form instead of silently logging the user in. */
  recovery: boolean;
  clearRecovery: () => void;
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
  const [recovery, setRecovery] = useState(false);
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
      setTelemetryUser(data.session?.user?.id ?? null);
      setLoading(false);
      await ensureProvisioned(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // A recovery link establishes a session — flag it so routing opens the reset form instead of
      // dropping the user into the app (RecoveryRedirect + useAuthForm honor this).
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
      setTelemetryUser(s?.user?.id ?? null); // associate analytics/crashlytics with the user
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
        // Client signUp so Supabase emails the confirmation code. The workspace name rides in user
        // metadata and is consumed by /auth/provision on the first authenticated session (same path
        // Google sign-in uses). With "Confirm email" OFF, a session is returned immediately.
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: workspaceName ? { data: { workspace_name: workspaceName } } : undefined,
        });
        if (error) throw error;
        return { needsConfirmation: !data.session };
      },
      confirmSignup: async (email, token) => {
        const { error } = await supabase.auth.verifyOtp({ email, token, type: 'signup' });
        if (error) throw error;
      },
      resendSignupCode: async (email) => {
        const { error } = await supabase.auth.resend({ type: 'signup', email });
        if (error) throw error;
      },
      sendLoginCode: async (email) => {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (error) throw error;
      },
      verifyLoginCode: async (email, token) => {
        const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
        if (error) throw error;
      },
      signInGoogle: async () => {
        // Native (Capacitor): the app loads from localhost, so redirect to the real web origin's App
        // Link (https://lntera.ai/login). Open Google in the system browser (skipBrowserRedirect) — the
        // verified App Link reopens THIS app, where NativeDeepLinks completes the PKCE session.
        if (IS_NATIVE) {
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: `${NATIVE_AUTH_SCHEME}://login`, skipBrowserRedirect: true },
          });
          if (error) throw error;
          if (data?.url) {
            const { Browser } = await import('@capacitor/browser');
            await Browser.open({ url: data.url });
          }
          return;
        }
        // Web: full-page redirect in the SAME tab — robust everywhere. (A popup/new tab can't be reliably
        // closed once Google's Cross-Origin-Opener-Policy severs window.opener, which left a second
        // logged-in session tab; single-tab redirect avoids that entirely.)
        // BASE_URL ends with '/', so `${origin}/app/login` (monolith) or `${origin}/login` (Vercel).
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: `${location.origin}${import.meta.env.BASE_URL}login` },
        });
        if (error) throw error;
      },
      resetPassword: async (email) => {
        // Native opens the email link via the App Link (https://lntera.ai/reset-password → this app);
        // web stays on its own origin. BASE_URL ends with '/'.
        const redirectTo = IS_NATIVE
          ? `${NATIVE_AUTH_SCHEME}://reset-password`
          : `${location.origin}${import.meta.env.BASE_URL}reset-password`;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
      },
      updatePassword: async (password) => {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
      },
      recovery,
      clearRecovery: () => setRecovery(false),
      signOut: async () => {
        setRecovery(false);
        // Detach this device from the current tenant's push subscription BEFORE clearing the session,
        // so a later login as a different account re-points cleanly (and old-tenant pushes stop).
        await logoutPush().catch(() => {});
        await supabase.auth.signOut();
      },
    }),
    [supabase, session, loading, recovery],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
