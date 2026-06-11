import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../../theme';
import { Container } from './Container';
import { BrandMark } from './BrandMark';

/** Sticky, minimal header — brand left, two actions right. */
export function LandingNav() {
  const navigate = useNavigate();
  const toForm = () =>
    document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <header className="sticky top-0 z-40 border-b bg-[hsl(var(--bg)/0.72)] backdrop-blur-md safe-t">
      <Container className="flex h-16 items-center justify-between">
        <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Lntera — top">
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
