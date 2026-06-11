import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '../../lib/useReducedMotion';

/**
 * A Browserbase-style "agent cursor" that glides over the hero product frame and clicks targets,
 * looping calmly. Dependency-free (Web Animations API), transform/opacity only (GPU compositor),
 * pointer-events:none, pauses offscreen / on tab-hide, rebuilds on resize, and disables under
 * prefers-reduced-motion. Render as a SIBLING of the (overflow-hidden) MockChat inside a relative
 * wrapper so it can glide off the card edge.
 */

type Waypoint = { o: number; x: number; y: number; e: string; op: number };

// Path as fractions of the overlay box (x,y in 0..1; y>1 = off the bottom edge). Per-keyframe
// easing shapes the segment that STARTS at that keyframe; the global timeline easing stays linear.
const PATH: Waypoint[] = [
  { o: 0.0, x: 0.04, y: 0.96, e: 'cubic-bezier(.22,.61,.36,1)', op: 0 },
  { o: 0.05, x: 0.22, y: 0.92, e: 'cubic-bezier(.22,.61,.36,1)', op: 1 },
  { o: 0.16, x: 0.58, y: 0.9, e: 'linear', op: 1 },
  { o: 0.26, x: 0.58, y: 0.9, e: 'cubic-bezier(.4,0,.2,1)', op: 1 }, // dwell + CLICK 1 (composer)
  { o: 0.46, x: 0.32, y: 0.45, e: 'cubic-bezier(.4,0,.2,1)', op: 1 },
  { o: 0.56, x: 0.32, y: 0.45, e: 'cubic-bezier(.45,0,.55,1)', op: 1 }, // dwell + CLICK 2 (reply)
  { o: 0.7, x: 0.82, y: 0.22, e: 'cubic-bezier(.55,.06,.68,.19)', op: 1 },
  { o: 0.88, x: 0.5, y: 1.12, e: 'linear', op: 1 },
  { o: 0.95, x: 0.36, y: 1.18, e: 'linear', op: 0 },
  { o: 1.0, x: 0.04, y: 0.96, e: 'linear', op: 0 },
];

const CLICKS: { at: number; x: number; y: number }[] = [
  { at: 0.26, x: 0.58, y: 0.9 },
  { at: 0.56, x: 0.32, y: 0.45 },
];

export function AgentCursor({
  duration = 9000,
  label = 'Lntera',
  className,
}: {
  duration?: number;
  label?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const layerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<SVGSVGElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduced) return;
    const layer = layerRef.current;
    const cursor = cursorRef.current;
    const arrow = arrowRef.current;
    const ripple = rippleRef.current;
    if (!layer || !cursor || !arrow || !ripple) return;
    if (typeof window === 'undefined' || typeof cursor.animate !== 'function') return;

    let cancelled = false;
    let anim: Animation | null = null;
    let raf = 0;
    let lastPhase = 0;
    let W = 0;
    let H = 0;

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

    const buildFrames = (): Keyframe[] =>
      PATH.map((w) => ({
        offset: w.o,
        transform: `translate3d(${(w.x * W).toFixed(1)}px, ${(w.y * H).toFixed(1)}px, 0)`,
        opacity: w.op,
        easing: w.e,
      }));

    const start = (seed = 0) => {
      const r = layer.getBoundingClientRect();
      W = r.width;
      H = r.height;
      if (W === 0 || H === 0) return;
      anim = cursor.animate(buildFrames(), { duration, iterations: Infinity, easing: 'linear' });
      try {
        anim.currentTime = seed;
      } catch {
        /* ignore */
      }
    };

    const press = () => {
      arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.82)' }, { transform: 'scale(1)' }], {
        duration: 220,
        easing: 'cubic-bezier(.34,1.56,.64,1)',
      });
    };

    const pulse = (cx: number, cy: number) => {
      const px = (cx * W).toFixed(1);
      const py = (cy * H).toFixed(1);
      ripple.animate(
        [
          { transform: `translate3d(${px}px, ${py}px, 0) scale(0.3)`, opacity: 0.5 },
          { transform: `translate3d(${px}px, ${py}px, 0) scale(2.4)`, opacity: 0 },
        ],
        { duration: 540, easing: 'cubic-bezier(0,.55,.45,1)' },
      );
    };

    const tick = () => {
      if (cancelled || !anim) return;
      const phase = (num(anim.currentTime) % duration) / duration;
      for (const c of CLICKS) {
        if (lastPhase < c.at && phase >= c.at) {
          press();
          pulse(c.x, c.y);
        }
      }
      lastPhase = phase;
      raf = requestAnimationFrame(tick);
    };

    start(0);
    raf = requestAnimationFrame(tick);

    // Pause when offscreen or tab hidden (battery + calm).
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!anim) continue;
            if (e.isIntersecting) anim.play();
            else anim.pause();
          }
        },
        { threshold: 0.05 },
      );
      io.observe(layer);
    }
    const onVis = () => {
      if (!anim) return;
      if (document.hidden) anim.pause();
      else anim.play();
    };
    document.addEventListener('visibilitychange', onVis);

    // Rebuild from fractions on resize, preserving the loop phase.
    let ro: ResizeObserver | null = null;
    let resizeT = 0;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        window.clearTimeout(resizeT);
        resizeT = window.setTimeout(() => {
          if (cancelled) return;
          const t = anim ? num(anim.currentTime) : 0;
          anim?.cancel();
          start(t);
        }, 140);
      });
      ro.observe(layer);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeT);
      anim?.cancel();
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reduced, duration]);

  if (reduced) return null;

  return (
    <div ref={layerRef} className={cn('lp-cursor-layer', className)} aria-hidden>
      <div ref={cursorRef} className="lp-cursor">
        <svg ref={arrowRef} className="lp-cursor-arrow" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path
            d="M1 1 L1 12.5 L4.2 9.6 L6.3 14.5 L8.4 13.6 L6.3 8.8 L10.7 8.8 Z"
            stroke="hsl(var(--bg))"
            strokeWidth="0.9"
            strokeLinejoin="round"
          />
        </svg>
        {label ? <span className="lp-cursor-tag">{label}</span> : null}
      </div>
      <span ref={rippleRef} className="lp-cursor-ripple" />
    </div>
  );
}
