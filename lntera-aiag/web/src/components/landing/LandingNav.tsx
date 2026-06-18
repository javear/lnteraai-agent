import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '../../theme';
import { Container } from './Container';
import { BrandMark } from './BrandMark';

/**
 * Sticky, minimal header. While at the very top it sits over the deep-space hero, so it adopts the
 * `.lp-space` dark scope (near-black frosted, off-white text); once scrolled into the themeable body
 * it switches to the page's own frosted surface. The swap cross-fades via transition-colors.
 */
export function LandingNav() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toForm = () =>
    document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b backdrop-blur-md safe-t transition-colors duration-300',
        scrolled
          ? 'bg-[hsl(var(--bg)/0.72)] text-[hsl(var(--fg))]'
          : 'lp-space border-[hsl(var(--line)/0.6)] bg-[hsl(var(--bg)/0.5)] text-[hsl(var(--fg))]',
      )}
    >
      <Container className="flex h-16 items-center justify-between">
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Lntera — top"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--bg))]"
        >
          <BrandMark />
        </button>
        <div className="flex items-center gap-1.5 sm:gap-3">
          <ThemeToggle />
          <button onClick={() => navigate('/login')} className="lp-link hidden sm:inline-block">
            Sign in
          </button>
          <button onClick={toForm} className="lp-btn !px-4 !py-2 !text-[0.85rem]">
            Start free
          </button>
        </div>
      </Container>
    </header>
  );
}
