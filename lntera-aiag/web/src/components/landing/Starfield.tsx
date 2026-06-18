import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../lib/useReducedMotion';

/**
 * GPU-light canvas starfield for the deep-space sections: stars drift slowly upward, twinkle, and
 * gently FLOW in the direction the cursor moves (depth-parallax — bigger/nearer stars react more).
 * One canvas (no per-star DOM), DPR-aware, paused when offscreen or when the tab is hidden, and
 * reduced to a single static frame under prefers-reduced-motion. A few stars carry a warm orange glow.
 */
export function Starfield({
  className,
  density = 0.00018,
  accent = true,
}: {
  className?: string;
  /** Stars per square pixel (count = area × density, capped). */
  density?: number;
  /** Give roughly 1-in-14 stars a brand-orange tint + halo. */
  accent?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    type Star = { x: number; y: number; r: number; a: number; tw: number; ph: number; vy: number; depth: number; hot: boolean };
    let stars: Star[] = [];
    let W = 0;
    let H = 0;
    let raf = 0;
    let last = 0;
    let running = false;
    let inView = true;
    // Cursor-flow vector (px/frame), accumulated from pointer movement and decayed each frame.
    let flowX = 0;
    let flowY = 0;
    let lastPx: number | null = null;
    let lastPy: number | null = null;

    const MIN_R = 0.8;
    const MAX_R = 2.6;

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(220, Math.round(W * H * density));
      stars = Array.from({ length: count }, (_, i) => {
        const r = Math.random() * (MAX_R - MIN_R) + MIN_R;
        return {
          x: Math.random() * W,
          y: Math.random() * H,
          r,
          a: Math.random() * 0.45 + 0.4, // brighter so they actually read
          tw: Math.random() * 0.7 + 0.25,
          ph: Math.random() * Math.PI * 2,
          vy: Math.random() * 7 + 3, // px/sec upward drift
          depth: 0.35 + ((r - MIN_R) / (MAX_R - MIN_R)) * 1.0, // bigger ⇒ nearer ⇒ parallaxes more
          hot: accent && i % 14 === 0,
        };
      });
    };

    const paint = (time: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        const tw = 0.6 + 0.4 * Math.sin(time * s.tw + s.ph);
        const a = Math.min(1, s.a * tw);
        if (s.hot) {
          // soft warm halo
          const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
          g.addColorStop(0, `rgba(255,140,70,${a * 0.8})`);
          g.addColorStop(1, 'rgba(255,140,70,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.hot ? `rgba(255,160,90,${a})` : `rgba(255,255,255,${a})`;
        ctx.fill();
      }
    };

    const tick = (now: number) => {
      if (!running) return;
      if (!last) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const s of stars) {
        s.y -= s.vy * dt; // ambient upward drift
        s.x += flowX * s.depth; // cursor-direction flow (parallax by depth)
        s.y += flowY * s.depth;
        if (s.y < -3) s.y = H + 3;
        else if (s.y > H + 3) s.y = -3;
        if (s.x < -3) s.x = W + 3;
        else if (s.x > W + 3) s.x = -3;
      }
      flowX *= 0.9; // decay so the flow trails off after the cursor stops
      flowY *= 0.9;
      paint(now / 1000);
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const sync = () => (inView && !document.hidden ? start() : stop());

    const onPointer = (e: PointerEvent) => {
      if (lastPx != null && lastPy != null) {
        const cap = 2.4;
        flowX = Math.max(-cap, Math.min(cap, flowX + (e.clientX - lastPx) * 0.05));
        flowY = Math.max(-cap, Math.min(cap, flowY + (e.clientY - lastPy) * 0.05));
      }
      lastPx = e.clientX;
      lastPy = e.clientY;
    };

    build();

    if (reduced) {
      paint(0); // single static frame, no loop, no cursor reaction
      const ro = new ResizeObserver(() => {
        build();
        paint(0);
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView = e.isIntersecting;
        sync();
      },
      { threshold: 0 },
    );
    io.observe(canvas);
    const onVis = () => sync();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pointermove', onPointer, { passive: true });
    const ro = new ResizeObserver(() => {
      build();
      if (!running) paint(0);
    });
    ro.observe(canvas);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
    };
  }, [reduced, density, accent]);

  return <canvas ref={ref} aria-hidden className={className} style={{ display: 'block', width: '100%', height: '100%' }} />;
}
