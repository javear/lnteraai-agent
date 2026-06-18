import { useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/landing/BrandMark';
import { BrandAuth } from '../components/landing/BrandAuth';
import { SpaceBackdrop } from '../components/landing/SpaceBackdrop';
import '../styles/landing.css';

/**
 * Focused, brand-styled sign-in. Also the Google-OAuth return URL and the logged-out deep-link
 * target — matches the landing's look (orange mark, Geist, single accent) without the marketing scroll.
 */
export default function Login() {
  const navigate = useNavigate();
  return (
    <div className="lp lp-space flex min-h-dvh flex-col overflow-hidden bg-[hsl(var(--bg))] text-[hsl(var(--fg))]">
      <SpaceBackdrop glow="center" />
      <header className="safe-t relative z-10 px-5 py-5 sm:px-8 sm:py-6">
        <button
          onClick={() => navigate('/')}
          aria-label="Lntera — home"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--bg))]"
        >
          <BrandMark />
        </button>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-12 sm:px-5 sm:pb-16">
        <div className="w-full max-w-sm">
          <h1 className="lp-display text-[2.1rem] leading-[1.05]">Welcome back.</h1>
          <p className="mt-2.5 text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
            Sign in to your storefront — or create a new workspace.
          </p>
          <div className="mt-7">
            <BrandAuth defaultMode="signin" />
          </div>
        </div>
      </main>
    </div>
  );
}
