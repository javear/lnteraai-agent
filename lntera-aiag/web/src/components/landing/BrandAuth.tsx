import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n';
import { GoogleGlyph } from '../auth/GoogleGlyph';
import { GoogleOneTap } from '../auth/GoogleOneTap';
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
  const t = useT();
  const showPassword = f.mode === 'signup' || (f.mode === 'signin' && !f.useCode);

  // ── Code entry (signup confirmation OR passwordless login) ──────────────────
  if (f.step === 'confirm' || f.step === 'code') {
    return (
      <div className={cn('w-full', className)}>
        <form onSubmit={f.onVerify} className="space-y-3">
          {f.info ? <p className="text-[13px] leading-relaxed text-[hsl(var(--fg-soft))]">{f.info}</p> : null}
          <label className="block">
            <span className={labelCls}>{t('auth.codeLabel')}</span>
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
              placeholder={t('auth.codePlaceholder')}
            />
          </label>
          <button type="submit" disabled={f.busy || !f.online || f.code.length < 6} className="lp-btn w-full">
            {f.busy ? t('auth.verifying') : f.step === 'confirm' ? t('auth.confirmContinue') : t('auth.verifySignIn')}
          </button>
        </form>
        <div className="mt-4 flex items-center justify-between text-[0.82rem]">
          <button type="button" onClick={f.backToForm} className="lp-link">
            {t('auth.back')}
          </button>
          <button type="button" onClick={f.resendCode} disabled={!f.online} className="lp-link">
            {t('auth.resend')}
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
      {/* Google One Tap (auto account chip → one-tap sign-in). No-op unless googleClientId is set. */}
      <GoogleOneTap />
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
            {m === 'signup' ? t('auth.createAccount') : t('auth.signIn')}
          </button>
        ))}
      </div>

      <form onSubmit={f.onSubmit} className="mt-4 space-y-3">
        {f.mode === 'signup' && (
          <label className="block">
            <span className={labelCls}>{t('auth.workspaceOptional')}</span>
            <input
              className="lp-field"
              value={f.workspace}
              onChange={(e) => f.setWorkspace(e.target.value)}
              placeholder={t('auth.workspacePlaceholder')}
            />
          </label>
        )}
        <label className="block">
          <span className={labelCls}>{t('auth.email')}</span>
          <input
            type="email"
            autoComplete="email"
            required
            className="lp-field"
            value={f.email}
            onChange={(e) => f.setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
          />
        </label>
        {showPassword && (
          <label className="block">
            <span className={labelCls}>{t('auth.password')}</span>
            <input
              type="password"
              required
              autoComplete={f.mode === 'signin' ? 'current-password' : 'new-password'}
              className="lp-field"
              value={f.password}
              onChange={(e) => f.setPassword(e.target.value)}
              placeholder={f.mode === 'signin' ? '••••••••' : t('auth.passwordMin')}
            />
          </label>
        )}
        {f.mode === 'signin' && !f.useCode ? (
          <div className="-mt-1 flex justify-end">
            <button type="button" onClick={() => navigate('/forgot-password')} className="lp-link text-[0.82rem]">
              {t('auth.forgot')}
            </button>
          </div>
        ) : null}
        <button type="submit" disabled={f.busy || !f.online} className="lp-btn w-full">
          {f.busy
            ? t('auth.oneMoment')
            : f.mode === 'signin'
              ? f.useCode
                ? t('auth.emailCode')
                : t('auth.signIn')
              : t('auth.startFree')}
        </button>
      </form>

      {f.mode === 'signin' ? (
        <div className="mt-3 text-center">
          <button type="button" onClick={f.toggleUseCode} className="lp-link text-[0.82rem]">
            {f.useCode ? t('auth.usePassword') : t('auth.useCode')}
          </button>
        </div>
      ) : null}

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
        <span className="lp-mono text-[0.66rem] uppercase tracking-[0.2em] text-[hsl(var(--fg-soft))]">{t('auth.or')}</span>
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
      </div>

      <button
        type="button"
        onClick={f.onGoogle}
        disabled={!f.online}
        className="lp-btn-ghost w-full justify-center disabled:opacity-50"
      >
        <GoogleGlyph />
        {t('auth.continueGoogle')}
      </button>

      {!f.online ? (
        <p className="lp-mono mt-3 text-[0.72rem] text-[hsl(var(--fg-soft))]">{t('auth.offlineSignIn')}</p>
      ) : null}
      {f.error ? (
        <p className="mt-3 rounded-lg border bg-[hsl(var(--bg-2))] px-3 py-2 text-[0.82rem] text-[hsl(var(--fg))]">
          {f.error}
        </p>
      ) : null}
    </div>
  );
}
