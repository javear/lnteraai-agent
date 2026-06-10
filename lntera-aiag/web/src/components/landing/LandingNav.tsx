import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../../theme';
import { Button, Logo } from '../../ui';
import { Container } from './Container';

/** Sticky marketing header: brand left, theme + auth actions right. */
export function LandingNav() {
  const navigate = useNavigate();
  const scrollToForm = () =>
    document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur safe-t">
      <Container className="flex h-16 items-center justify-between">
        <Logo size="md" />
        <div className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => navigate('/login')}>
            Sign in
          </Button>
          <Button onClick={scrollToForm}>Get started</Button>
        </div>
      </Container>
    </header>
  );
}
