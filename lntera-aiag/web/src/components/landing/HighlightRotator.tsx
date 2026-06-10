import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '../../lib/useReducedMotion';

/**
 * The "slider": cross-fades a list of short capability phrases with slide dots.
 * Reduced-motion safe — renders the phrases statically as chips.
 */
export function HighlightRotator({
  items,
  intervalMs = 2800,
  className,
}: {
  items: string[];
  intervalMs?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);

  useEffect(() => {
    if (reduced || items.length <= 1) return;
    const id = window.setInterval(() => setI((p) => (p + 1) % items.length), intervalMs);
    return () => clearInterval(id);
  }, [reduced, items.length, intervalMs]);

  if (reduced) {
    return (
      <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
        {items.map((t) => (
          <span
            key={t}
            className="rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-[13px] font-medium text-brand"
          >
            {t}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <div className="relative h-7 w-full">
        {items.map((t, idx) => (
          <span
            key={t}
            aria-hidden={idx !== i}
            className={cn(
              'absolute inset-0 flex items-center justify-center text-[15px] font-medium text-foreground transition-opacity duration-500',
              idx === i ? 'opacity-100' : 'opacity-0',
            )}
          >
            {t}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        {items.map((t, idx) => (
          <button
            key={t}
            type="button"
            aria-label={`Show: ${t}`}
            onClick={() => setI(idx)}
            className={cn(
              'h-1.5 rounded-full transition-all',
              idx === i ? 'w-5 bg-brand' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60',
            )}
          />
        ))}
      </div>
    </div>
  );
}
