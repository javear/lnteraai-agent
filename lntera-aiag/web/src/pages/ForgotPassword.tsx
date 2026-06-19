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
 * "Forgot password" — emails a Supabase recovery link (→ /reset-password). Mirrors the Login shell.
 * Always shows the same "check your inbox" confirmation on success, without revealing whether the
 * email is registered.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();
  const { resetPassword } = useAuth();
  const online = useOnlineStatus();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resetPassword(email.trim());
      setSent(true);
      toast.success('Check your inbox for the reset link.');
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
          {sent ? (
            <>
              <h1 className="lp-display text-[2.1rem] leading-[1.05]">Check your inbox.</h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
                If an account exists for{' '}
                <span className="font-medium text-[hsl(var(--fg))]">{email.trim()}</span>, we’ve sent a
                link to reset your password. It can take a minute to arrive — check spam too.
              </p>
              <button onClick={() => navigate('/login')} className="lp-btn mt-7 w-full">
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <h1 className="lp-display text-[2.1rem] leading-[1.05]">Reset your password.</h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
                Enter your email and we’ll send you a link to set a new one.
              </p>
              <form onSubmit={onSubmit} className="mt-7 space-y-3">
                <label className="block">
                  <span className={labelCls}>Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    className="lp-field"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@store.com"
                  />
                </label>
                <button type="submit" disabled={busy || !online} className="lp-btn w-full">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Send reset link
                </button>
              </form>
              {!online ? (
                <p className="lp-mono mt-3 text-[0.72rem] text-[hsl(var(--fg-soft))]">Offline — reconnect to send.</p>
              ) : null}
              {error ? (
                <p className="mt-3 rounded-lg border bg-[hsl(var(--bg-2))] px-3 py-2 text-[0.82rem] text-[hsl(var(--fg))]">
                  {error}
                </p>
              ) : null}
              <div className="mt-4 text-center">
                <button onClick={() => navigate('/login')} className="lp-link text-[0.85rem]">
                  Back to sign in
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
