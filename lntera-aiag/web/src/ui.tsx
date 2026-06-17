import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button as UiButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Re-export the canonical primitives so existing imports from `../ui` keep working.
export { Input } from '@/components/ui/input';
export { Textarea } from '@/components/ui/textarea';
export { Skeleton } from '@/components/ui/skeleton';

const LOGO_SIZES = {
  sm: { tile: 'h-7 w-7 rounded-lg', svg: 16, gap: 'gap-2', text: 'text-sm' },
  md: { tile: 'h-9 w-9 rounded-xl', svg: 20, gap: 'gap-2.5', text: 'text-base' },
  lg: { tile: 'h-12 w-12 rounded-2xl', svg: 26, gap: 'gap-3', text: 'text-xl' },
} as const;

/** Brand mark: an "L" monogram + spark in a rounded tile, with the "Lntera" wordmark. */
export function Logo({
  className,
  size = 'sm',
  wordmark = true,
}: {
  className?: string;
  size?: keyof typeof LOGO_SIZES;
  wordmark?: boolean;
}) {
  const s = LOGO_SIZES[size];
  return (
    <div className={cn('flex items-center', s.gap, className)}>
      <div className={cn('flex shrink-0 items-center justify-center bg-brand', s.tile)}>
        <svg width={s.svg} height={s.svg} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {/* "L" monogram */}
          <path d="M8 5.5a1.4 1.4 0 0 1 2.8 0v9.1h5.1a1.4 1.4 0 0 1 0 2.8H8z" className="fill-white" />
          {/* spark */}
          <path
            d="M17 5.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8L14.5 7.7l1.8-.7z"
            className="fill-white"
            opacity="0.72"
          />
        </svg>
      </div>
      {wordmark ? (
        <span className={cn('font-semibold tracking-tight text-foreground', s.text)}>Lntera</span>
      ) : null}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  block?: boolean;
};

const VARIANT_MAP = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
} as const;

/** App button — preserves the legacy variant names, delegates to the shadcn primitive. */
export function Button({ variant = 'primary', block, className, ...rest }: BtnProps) {
  return <UiButton variant={VARIANT_MAP[variant]} className={cn(block && 'w-full', className)} {...rest} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
        {hint ? <span className="ml-1 font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-xl border bg-card p-5 text-card-foreground shadow-sm', className)}>
      {children}
    </div>
  );
}

export function Badge({ tone, children }: { tone: 'success' | 'danger' | 'neutral'; children: ReactNode }) {
  const tones: Record<string, string> = {
    success: 'border-success/25 bg-success/10 text-success',
    danger: 'border-destructive/25 bg-destructive/10 text-destructive',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tones[tone],
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Alert({ tone, children }: { tone: 'success' | 'error' | 'neutral'; children: ReactNode }) {
  const tones: Record<string, string> = {
    success: 'border-success/25 bg-success/10 text-success',
    error: 'border-destructive/25 bg-destructive/10 text-destructive',
    neutral: 'border-border bg-muted text-foreground',
  };
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('mt-4 rounded-lg border px-3.5 py-3 text-sm leading-relaxed', tones[tone])}
    >
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mb-6 flex gap-1 rounded-lg border bg-muted p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-16">
      <div className="mb-10 flex items-center justify-between sm:mb-12">
        <Logo />
        {right}
      </div>
      {children}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-xl">{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <div className="mt-5">{children}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-4">{children}</ol>;
}

export function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="text-sm leading-relaxed">
        <div className="font-medium text-foreground">{title}</div>
        {children ? <div className="mt-1 text-[13px] text-muted-foreground">{children}</div> : null}
      </div>
    </li>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>
  );
}

export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-md border border-input bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}

export function Avatar({ label, tone = 'ink' }: { label: string; tone?: 'ink' | 'muted' }) {
  const initials = label.trim().slice(0, 2).toUpperCase() || '?';
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
        tone === 'ink' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {initials}
    </span>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="Assistant is typing">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s] motion-reduce:animate-none motion-reduce:opacity-60" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s] motion-reduce:animate-none motion-reduce:opacity-60" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground motion-reduce:animate-none motion-reduce:opacity-60" />
    </span>
  );
}
