import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { BrandMark } from '../components/landing/BrandMark';
import { SpaceBackdrop } from '../components/landing/SpaceBackdrop';
import '../styles/landing.css';

const labelCls = 'lp-mono mb-1.5 block text-[0.7rem] uppercase tracking-wider text-[hsl(var(--fg-soft))]';
const brandMarkBtn =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--bg))]';

/**
 * Landing target of the Supabase recovery email. The client (detectSessionInUrl + PKCE) has already
 * exchanged the `?code=` into a session by the time this renders, so a present session = a valid
 * recovery link. We deliberately use useAuth() directly (NOT useAuthForm) so the session doesn't
 * auto-bounce us to the app before the user sets a new password.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const { session, loading, recovery, updatePassword, clearRecovery } = useAuth();
  const online = useOnlineStatus();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
      clearRecovery(); // leave recovery mode so routing lets us into the app
      toast.success('Password updated.');
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lp lp-space flex min-h-dvh flex-col overflow-hidden bg-[hsl(var(--bg))] text-[hsl(var(--fg))]">
      <SpaceBackdrop glow="center" />
      <header className="safe-t relative z-10 px-5 py-5 sm:px-8 sm:py-6">
        <button onClick={() => navigate('/')} aria-label="Lntera — home" className={brandMarkBtn}>
          <BrandMark />
        </button>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-12 sm:px-5 sm:pb-16">
        <div className="w-full max-w-sm">
          {loading ? (
            <div className="flex justify-center pt-10">
              <Loader2 className="h-6 w-6 animate-spin text-[hsl(var(--fg-soft))]" />
            </div>
          ) : !session && !recovery ? (
            <>
              <h1 className="lp-display text-[2.1rem] leading-[1.05]">Link expired.</h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
                This password reset link is invalid or has expired. Request a new one to continue.
              </p>
              <button onClick={() => navigate('/forgot-password')} className="lp-btn mt-7 w-full">
                Request a new link
              </button>
            </>
          ) : (
            <>
              <h1 className="lp-display text-[2.1rem] leading-[1.05]">Set a new password.</h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
                Choose a new password for your account.
              </p>
              <form onSubmit={onSubmit} className="mt-7 space-y-3">
                <label className="block">
                  <span className={labelCls}>New password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    className="lp-field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                  />
                </label>
                <label className="block">
                  <span className={labelCls}>Confirm password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    className="lp-field"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Re-enter password"
                  />
                </label>
                <button type="submit" disabled={busy || !online} className="lp-btn w-full">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Update password
                </button>
              </form>
              {!online ? (
                <p className="lp-mono mt-3 text-[0.72rem] text-[hsl(var(--fg-soft))]">Offline — reconnect to update.</p>
              ) : null}
              {error ? (
                <p className="mt-3 rounded-lg border bg-[hsl(var(--bg-2))] px-3 py-2 text-[0.82rem] text-[hsl(var(--fg))]">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
