import { cn } from '@/lib/utils';
import { Starfield } from './Starfield';

/**
 * Ambient layers for a deep-space section. The near-black surface + off-white text come from the
 * `.lp-space` token scope on the parent; this paints (back→front): a faint masked dot-grid, the
 * drifting starfield, and a warm orange radial glow that breathes. Purely decorative (aria-hidden);
 * the section's real content sits above it via `relative z-10`.
 */
export function SpaceBackdrop({ glow = 'top', className }: { glow?: 'top' | 'center'; className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <div className="lp-space-grid absolute inset-0" />
      <Starfield className="absolute inset-0 h-full w-full" />
      <div className={glow === 'center' ? 'lp-space-glow lp-space-glow--center' : 'lp-space-glow lp-space-glow--top'} />
    </div>
  );
}
