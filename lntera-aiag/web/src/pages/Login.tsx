import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Alert, Button, Field, Input, Logo, Segmented } from '../ui';

type Mode = 'signin' | 'signup';

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

export default function Login() {
  const { session, loading, signInPassword, signUp, signInGoogle } = useAuth();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) navigate('/', { replace: true });
  }, [loading, session, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signInPassword(email.trim(), password);
      else await signUp(email.trim(), password, workspace.trim() || undefined);
      navigate('/', { replace: true });
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

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10 sm:py-16">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
          <Logo />
          <h1 className="mt-7 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </h1>
          <p className="mb-7 mt-2 text-[15px] text-muted-foreground">
            {mode === 'signin' ? 'Access your workspace.' : "New workspace — you'll be its owner."}
          </p>

          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: 'signin', label: 'Sign in' },
              { value: 'signup', label: 'Sign up' },
            ]}
          />

          <form onSubmit={onSubmit}>
            {mode === 'signup' && (
              <Field label="Workspace name" hint="(optional)">
                <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="My Store" />
              </Field>
            )}
            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signin' ? '••••••••' : 'At least 8 characters'}
              />
            </Field>
            <Button type="submit" block disabled={busy || !online}>
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            OR
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button type="button" variant="secondary" block onClick={onGoogle} disabled={!online}>
            <GoogleGlyph />
            Continue with Google
          </Button>

          {!online ? <Alert tone="neutral">You're offline — reconnect to sign in.</Alert> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </div>
    </div>
  );
}
