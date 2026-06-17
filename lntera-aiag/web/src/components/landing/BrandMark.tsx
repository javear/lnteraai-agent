import { cn } from '@/lib/utils';

/** Clean landing wordmark: off-white monogram tile + cyan spark + "Lntera" in Geist. */
export function BrandMark({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const tile = size === 'sm' ? 'h-7 w-7 rounded-lg' : 'h-8 w-8 rounded-[0.6rem]';
  const svg = size === 'sm' ? 15 : 17;
  const text = size === 'sm' ? 'text-[1.02rem]' : 'text-[1.16rem]';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className={cn('flex shrink-0 items-center justify-center bg-brand', tile)}>
        <svg width={svg} height={svg} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M8 5.5a1.4 1.4 0 0 1 2.8 0v9.1h5.1a1.4 1.4 0 0 1 0 2.8H8z" fill="#fff" />
          <path d="M17 5.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8L14.5 7.7l1.8-.7z" fill="#fff" fillOpacity="0.72" />
        </svg>
      </span>
      <span className={cn('font-semibold tracking-tight text-[hsl(var(--fg))]', text)}>Lntera</span>
    </span>
  );
}
