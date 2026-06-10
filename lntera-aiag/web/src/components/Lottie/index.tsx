import { CheckCircle2 } from 'lucide-react';
import { Logo } from '@/ui';
import { LazyLottie } from './LazyLottie';
import { bootAnimation } from './animations/boot';
import { chatEmptyAnimation } from './animations/chat-empty';
import { successAnimation } from './animations/success';

/** Boot/route splash — rotating brand mark; falls back to the static logo. */
export function BootSplashArt({ className }: { className?: string }) {
  return (
    <LazyLottie data={bootAnimation} className={className} ariaLabel="Loading" fallback={<Logo />} />
  );
}

/** Chat empty-state hero — breathing dots. */
export function ChatEmptyArt({ className }: { className?: string }) {
  return <LazyLottie data={chatEmptyAnimation} className={className} fallback={<Logo />} />;
}

/** Integration-connected confirmation — plays once. */
export function SuccessArt({ className }: { className?: string }) {
  return (
    <LazyLottie
      data={successAnimation}
      className={className}
      loop={false}
      ariaLabel="Connected"
      fallback={<CheckCircle2 className="h-full w-full text-success" />}
    />
  );
}
