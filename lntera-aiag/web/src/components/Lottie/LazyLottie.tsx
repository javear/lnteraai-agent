import { Suspense, lazy, type ReactNode } from 'react';

// The dotLottie player + WASM are heavy and load only when a Lottie actually mounts.
// We point the player at the bundled WASM (hashed asset) so it works offline with no CDN.
const DotLottie = lazy(async () => {
  const [mod, wasm] = await Promise.all([
    import('@lottiefiles/dotlottie-react'),
    import('@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'),
  ]);
  mod.setWasmUrl((wasm as { default: string }).default);
  return { default: mod.DotLottieReact };
});

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function LazyLottie({
  data,
  className,
  loop = true,
  autoplay = true,
  fallback = null,
  ariaLabel,
}: {
  data: Record<string, unknown>;
  className?: string;
  loop?: boolean;
  autoplay?: boolean;
  fallback?: ReactNode;
  ariaLabel?: string;
}) {
  // Honor reduced-motion: show the static fallback instead of an animation.
  if (prefersReducedMotion()) {
    return (
      <div className={className} role="img" aria-label={ariaLabel}>
        {fallback}
      </div>
    );
  }
  return (
    <div
      className={className}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <Suspense fallback={fallback}>
        <DotLottie
          data={data}
          loop={loop}
          autoplay={autoplay}
          renderConfig={{ autoResize: true }}
          className="h-full w-full"
        />
      </Suspense>
    </div>
  );
}
