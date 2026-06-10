import { AuthPanel } from '../components/auth/AuthPanel';

/** Focused auth page at /login. The marketing landing reuses the same <AuthPanel/> in its hero. */
export default function Login() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10 sm:py-16">
      <div className="w-full max-w-md animate-fade-in-up">
        <AuthPanel variant="card" />
      </div>
    </div>
  );
}
