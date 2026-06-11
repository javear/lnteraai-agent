import { useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/landing/BrandMark';
import { BrandAuth } from '../components/landing/BrandAuth';
import '../styles/landing.css';

/**
 * Focused, brand-styled sign-in. Also the Google-OAuth return URL and the logged-out deep-link
 * target — matches the landing's look (orange mark, Geist, single accent) without the marketing scroll.
 */
export default function Login() {
  const navigate = useNavigate();
  return (
    <div className="lp flex min-h-dvh flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-10%] top-[-18%] h-[440px] w-[600px] max-w-[120vw] rounded-full bg-[hsl(var(--brand)/0.08)] blur-[140px]"
      />
      <header className="relative z-10 px-5 py-5 sm:px-8 sm:py-6">
        <button onClick={() => navigate('/')} aria-label="Lntera — home">
          <BrandMark />
        </button>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16">
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
