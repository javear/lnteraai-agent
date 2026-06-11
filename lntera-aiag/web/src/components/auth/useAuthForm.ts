import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useOnlineStatus } from '../../lib/pwa';

export type AuthMode = 'signin' | 'signup';

/**
 * Shared sign-in / sign-up form logic. Both the focused /login card (AuthPanel) and the landing's
 * branded hero form (BrandAuth) consume this so the auth behavior is a single source of truth.
 */
export function useAuthForm({
  defaultMode = 'signin',
  redirectTo = '/',
}: { defaultMode?: AuthMode; redirectTo?: string } = {}) {
  const { session, loading, signInPassword, signUp, signInGoogle } = useAuth();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<AuthMode>(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) navigate(redirectTo, { replace: true });
  }, [loading, session, navigate, redirectTo]);

  function changeMode(m: AuthMode) {
    setMode(m);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signInPassword(email.trim(), password);
      else await signUp(email.trim(), password, workspace.trim() || undefined);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setError(null);
    try {
      await signInGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    mode,
    setMode: changeMode,
    email,
    setEmail,
    password,
    setPassword,
    workspace,
    setWorkspace,
    busy,
    error,
    online,
    onSubmit,
    onGoogle,
  };
}
