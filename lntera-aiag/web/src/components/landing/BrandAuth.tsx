import { cn } from '@/lib/utils';
import { GoogleGlyph } from '../auth/GoogleGlyph';
import { useAuthForm } from '../auth/useAuthForm';

const labelCls = 'lp-mono mb-1.5 block text-[0.7rem] uppercase tracking-wider text-[hsl(var(--fg-soft))]';

/** The brand-styled sign-up / sign-in form (landing hero + focused /login), shared auth logic. */
export function BrandAuth({
  className,
  defaultMode = 'signup',
}: {
  className?: string;
  defaultMode?: 'signin' | 'signup';
}) {
  const f = useAuthForm({ defaultMode, redirectTo: '/' });

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
        <button type="submit" disabled={f.busy || !f.online} className="lp-btn w-full">
          {f.busy ? 'One moment…' : f.mode === 'signin' ? 'Sign in' : 'Start free'}
        </button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
        <span className="lp-mono text-[0.66rem] uppercase tracking-[0.2em] text-[hsl(var(--fg-soft))]">or</span>
        <span className="h-px flex-1 bg-[hsl(var(--line))]" />
      </div>

      <button type="button" onClick={f.onGoogle} disabled={!f.online} className="lp-btn-ghost w-full justify-center disabled:opacity-50">
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
