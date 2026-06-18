import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '../../lib/useReducedMotion';

/**
 * Fades + lifts its children into view the first time they scroll into the viewport.
 * Reduced-motion safe (renders immediately at full opacity, no observer). Disconnects after reveal.
 */
export function Reveal({
  as,
  delay = 0,
  className,
  children,
}: {
  as?: ElementType;
  /** Stagger in milliseconds (applied as animation-delay once revealed). */
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const Tag = (as ?? 'div') as ElementType;
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [reduced]);

  const style: CSSProperties | undefined =
    shown && delay ? { animationDelay: `${delay}ms`, animationFillMode: 'both' } : undefined;

  return (
    <Tag ref={ref} className={cn(shown ? 'animate-reveal-up' : 'opacity-0', className)} style={style}>
      {children}
    </Tag>
  );
}
