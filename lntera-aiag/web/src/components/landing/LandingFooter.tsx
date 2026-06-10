import { useNavigate } from 'react-router-dom';
import { Logo } from '../../ui';
import { Container } from './Container';

/** Minimal marketing footer — no fabricated links. */
export function LandingFooter() {
  const navigate = useNavigate();
  const scrollToForm = () =>
    document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <footer className="border-t bg-muted/30">
      <Container className="flex flex-col items-center gap-5 py-10 text-center sm:flex-row sm:justify-between sm:text-left">
        <Logo size="sm" />
        <p className="order-last text-[13px] text-muted-foreground sm:order-none">
          © 2026 Lntera — your business agent for Shopee &amp; TikTok Shop.
        </p>
        <nav className="flex items-center gap-5 text-[13px] font-medium text-muted-foreground">
          <button onClick={() => navigate('/login')} className="transition-colors hover:text-foreground">
            Sign in
          </button>
          <button onClick={scrollToForm} className="transition-colors hover:text-foreground">
            Get started
          </button>
        </nav>
      </Container>
    </footer>
  );
}
