import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { GoogleGlyph } from '../auth/GoogleGlyph';
import { useAuthForm } from '../auth/useAuthForm';

const labelCls = 'lp-mono mb-1.5 block text-[0.7rem] uppercase tracking-wider text-[hsl(var(--fg-soft))]';

/** Brand-styled auth: password sign-in/sign-up, email-confirmation on sign-up, and passwordless
 *  login via an emailed 6-digit code — shared by the landing hero and the focused /login. */
export function BrandAuth({
  className,
  defaultMode = 'signup',
}: {
  className?: string;
  defaultMode?: 'signin' | 'signup';
}) {
  const f = useAuthForm({ defaultMode, redirectTo: '/' });
  const navigate = useNavigate();
  const showPassword = f.mode === 'signup' || (f.mode === 'signin' && !f.useCode);

  // ── Code entry (signup confirmation OR passwordless login) ──────────────────
  if (f.step === 'confirm' || f.step === 'code') {
    return (
      <div className={cn('w-full', className)}>
        <form onSubmit={f.onVerify} className="space-y-3">
          {f.info ? <p className="text-[13px] leading-relaxed text-[hsl(var(--fg-soft))]">{f.info}</p> : null}
          <label className="block">
            <span className={labelCls}>6-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              required
              autoFocus
              className="lp-field text-center text-[1.3rem] tabular-nums tracking-[0.3em]"
              value={f.code}
              // Supabase OTP length is configurable (6–10) — accept the full code, don't truncate.
              onChange={(e) => f.setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="Enter code"
            />
          </label>
          <button type="submit" disabled={f.busy || !f.online || f.code.length < 6} className="lp-btn w-full">
            {f.busy ? 'Verifying…' : f.step === 'confirm' ? 'Confirm & continue' : 'Verify & sign in'}
          </button>
        </form>
        <div className="mt-4 flex items-center justify-between text-[0.82rem]">
          <button type="button" onClick={f.backToForm} className="lp-link">
            ← Back
          </button>
          <button type="button" onClick={f.resendCode} disabled={!f.online} className="lp-link">
            Resend code
          </button>
        </div>
        {f.error ? (
          <p className="mt-3 rounded-lg border bg-[hsl(var(--bg-2))] px-3 py-2 text-[0.82rem] text-[hsl(var(--fg))]">
            {f.error}
          </p>
        ) : null}
      </div>
    );
  }

  // ── Email / password form ───────────────────────────────────────────────────
  return (
    <div className={cn('w-full', className)}>
      <div className="inline-flex rounded-full border p-0.5 text-[0.82rem]">
        {(['signup', 'signin'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => f.setMode(m)}
            className={cn(
              'rounded-full px-3.5 py-1.5 font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--bg))]',
              f.mode === m
                ? 'bg-brand text-brand-foreground'
                : 'text-[hsl(var(--fg-soft))] hover:text-[hsl(var(--fg))]',
            )}
          >
            {m === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        ))}
      </div>

      <form onSubmit={f.onSubmit} className="mt-4 space-y-3">
        {f.mode === 'signup' && (
          <label className="block">
            <span className={labelCls}>Workspace · optional</span>
            <input
              className="lp-field"
              value={f.workspace}
              onChange={(e) => f.setWorkspace(e.target.value)}
              placeholder="My Store"
            />
          </label>
        )}
        <label className="block">
          <span className={labelCls}>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            className="lp-field"
            value={f.email}
            onChange={(e) => f.setEmail(e.target.value)}
            placeholder="you@store.com"
          />
        </label>
        {showPassword && (
          <label className="block">
            <span className={labelCls}>Password</span>
            <input
              type="password"
              required
              autoComplete={f.mode === 'signin' ? 'current-password' : 'new-password'}
              className="lp-field"
              value={f.password}
              onChange={(e) => f.setPassword(e.target.value)}
              placeholder={f.mode === 'signin' ? '••••••••' : 'At least 8 characters'}
            />
          </label>
        )}
        {f.mode === 'signin' && !f.useCode ? (
          <div className="-mt-1 flex justify-end">
            <button type="button" onClick={() => navigate('/forgot-password')} className="lp-link text-[0.82rem]">
              Forgot password?
            </button>
          </div>
        ) : null}
        <button type="submit" disabled={f.busy || !f.online} className="lp-btn w-full">
          {f.busy
            ? 'One moment…'
            : f.mode === 'signin'
              ? f.useCode
                ? 'Email me a code'
                : 'Sign in'
              : 'Start free'}
        </button>
      </form>

      {f.mode === 'signin' ? (
        <div className="mt-3 text-center">
          <button type="button" onClick={f.toggleUseCode} className="lp-link text-[0.82rem]">
            {f.useCode ? 'Use a password instead' : 'Sign in with an email code'}
          </button>
        </div>
      ) : null}

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
        <span className="lp-mono text-[0.66rem] uppercase tracking-[0.2em] text-[hsl(var(--fg-soft))]">or</span>
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
      </div>

      <button
        type="button"
        onClick={f.onGoogle}
        disabled={!f.online}
        className="lp-btn-ghost w-full justify-center disabled:opacity-50"
      >
        <GoogleGlyph />
        Continue with Google
      </button>

      {!f.online ? (
        <p className="lp-mono mt-3 text-[0.72rem] text-[hsl(var(--fg-soft))]">Offline — reconnect to sign in.</p>
      ) : null}
      {f.error ? (
        <p className="mt-3 rounded-lg border bg-[hsl(var(--bg-2))] px-3 py-2 text-[0.82rem] text-[hsl(var(--fg))]">
          {f.error}
        </p>
      ) : null}
    </div>
  );
}
