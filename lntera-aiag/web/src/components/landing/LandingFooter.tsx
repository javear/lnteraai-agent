import { useNavigate } from 'react-router-dom';
import { Container } from './Container';
import { BrandMark } from './BrandMark';

/** Minimal footer — no fabricated pages. */
export function LandingFooter() {
  const navigate = useNavigate();
  const toForm = () =>
    document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <footer className="border-t">
      <Container className="flex flex-col items-center gap-6 py-10 sm:flex-row sm:justify-between">
        <BrandMark size="sm" />
        <p className="lp-mono text-[0.7rem] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
          Your business agent · est. 2026
        </p>
        <nav className="flex items-center gap-6">
          <button onClick={() => navigate('/login')} className="lp-link">
            Sign in
          </button>
          <button onClick={toForm} className="lp-link">
            Start free
          </button>
        </nav>
      </Container>
    </footer>
  );
}
