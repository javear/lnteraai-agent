import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Centered max-width wrapper for landing sections (wider than the app's form Shell). */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-5 sm:px-6', className)}>{children}</div>;
}
