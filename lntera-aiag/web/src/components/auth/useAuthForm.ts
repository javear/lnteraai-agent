import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useOnlineStatus } from '../../lib/pwa';

export type AuthMode = 'signin' | 'signup';
/** 'form' = email/password entry; 'confirm' = signup code; 'code' = passwordless login code. */
export type AuthStep = 'form' | 'confirm' | 'code';

/**
 * Shared sign-in / sign-up form logic for BrandAuth (landing hero + /login). Supports:
 *  - password sign-in / sign-up,
 *  - email-confirmation on sign-up (6-digit code, type 'signup'),
 *  - passwordless login via emailed code (signInWithOtp + verifyOtp type 'email').
 */
export function useAuthForm({
  defaultMode = 'signin',
  redirectTo = '/',
}: { defaultMode?: AuthMode; redirectTo?: string } = {}) {
  const {
    session,
    loading,
    recovery,
    signInPassword,
    signUp,
    confirmSignup,
    resendSignupCode,
    sendLoginCode,
    verifyLoginCode,
    signInGoogle,
  } = useAuth();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<AuthMode>(defaultMode);
  const [step, setStep] = useState<AuthStep>('form');
  const [useCode, setUseCode] = useState(false); // sign in with an emailed code instead of a password
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    // Don't bounce into the app during password recovery — RecoveryRedirect sends them to /reset-password.
    if (!loading && session && !recovery) navigate(redirectTo, { replace: true });
  }, [loading, session, recovery, navigate, redirectTo]);

  function reset(extra?: () => void) {
    setStep('form');
    setCode('');
    setError(null);
    setInfo(null);
    extra?.();
  }
  function changeMode(m: AuthMode) {
    setMode(m);
    setUseCode(false);
    reset();
  }
  function backToForm() {
    reset();
  }
  function toggleUseCode() {
    setUseCode((v) => !v);
    setError(null);
    setInfo(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const addr = email.trim();
      if (mode === 'signup') {
        const { needsConfirmation } = await signUp(addr, password, workspace.trim() || undefined);
        if (needsConfirmation) {
          setStep('confirm');
          setInfo(`Enter the 6-digit code we emailed to ${addr}.`);
        } else {
          navigate(redirectTo, { replace: true });
        }
      } else if (useCode) {
        await sendLoginCode(addr);
        setStep('code');
        setInfo(`Enter the 6-digit code we emailed to ${addr}.`);
      } else {
        await signInPassword(addr, password);
        navigate(redirectTo, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Verify the 6-digit code — either the signup confirmation or the passwordless login code.
  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const addr = email.trim();
      if (step === 'confirm') await confirmSignup(addr, code.trim());
      else await verifyLoginCode(addr, code.trim());
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setError(null);
    setInfo(null);
    try {
      const addr = email.trim();
      if (step === 'confirm') await resendSignupCode(addr);
      else await sendLoginCode(addr);
      setInfo('A new code is on its way.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onGoogle() {
    setError(null);
    try {
      await signInGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    mode,
    setMode: changeMode,
    step,
    useCode,
    toggleUseCode,
    backToForm,
    email,
    setEmail,
    password,
    setPassword,
    workspace,
    setWorkspace,
    code,
    setCode,
    busy,
    error,
    info,
    online,
    onSubmit,
    onVerify,
    resendCode,
    onGoogle,
  };
}
