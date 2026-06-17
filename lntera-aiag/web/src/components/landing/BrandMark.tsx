import { cn } from '@/lib/utils';

/** Clean landing wordmark: orange monogram tile + monoline "L" + AI spark + "Lntera" in Geist. */
export function BrandMark({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const tile = size === 'sm' ? 'h-7 w-7 rounded-lg' : 'h-8 w-8 rounded-[0.6rem]';
  const svg = size === 'sm' ? 15 : 17;
  const text = size === 'sm' ? 'text-[1.02rem]' : 'text-[1.16rem]';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className={cn('flex shrink-0 items-center justify-center bg-brand', tile)}>
        <svg width={svg} height={svg} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M9 6.25V13.5a2.5 2.5 0 0 0 2.5 2.5H15.5"
            stroke="#fff"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M17 4.4C17.2 6.05 17.55 6.55 19.2 6.8C17.55 7.05 17.2 7.55 17 9.2C16.8 7.55 16.45 7.05 14.8 6.8C16.45 6.55 16.8 6.05 17 4.4Z"
            fill="#fff"
            fillOpacity="0.9"
          />
        </svg>
      </span>
      <span className={cn('font-semibold tracking-tight text-[hsl(var(--fg))]', text)}>Lntera</span>
    </span>
  );
}
