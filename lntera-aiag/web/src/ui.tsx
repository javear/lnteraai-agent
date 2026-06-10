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

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="2" width="5" height="5" className="fill-primary-foreground" />
          <rect x="9" y="2" width="5" height="5" className="fill-primary-foreground" />
          <rect x="2" y="9" width="5" height="5" className="fill-primary-foreground" />
          <rect x="9" y="9" width="5" height="5" className="fill-primary-foreground" opacity="0.4" />
        </svg>
      </div>
      <span className="text-sm font-semibold tracking-tight">lntera</span>
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
    <div className={cn('mt-4 rounded-lg border px-3.5 py-3 text-sm leading-relaxed', tones[tone])}>
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
    <span className="inline-flex items-center gap-1 py-1" aria-label="Assistant is typing">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
    </span>
  );
}
