// Generation status while the agent works: three softly-bouncing dots + a localized status word that
// rotates every few seconds (Claude-Code style, so waiting feels alive), with an optional live preview
// of the model's reasoning. Purely ephemeral — shown only while generating, never persisted.
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-brand/70 motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 0.16}s`, animationDuration: '0.9s' }}
        />
      ))}
    </span>
  );
}

export function ThinkingIndicator({ reasoning, label, className }: { reasoning?: string; label?: string; className?: string }) {
  const t = useT();
  const words = (label ? [label] : (t('thinking.words') || 'Thinking').split('|').map((w) => w.trim()).filter(Boolean));
  const [i, setI] = useState(0);

  useEffect(() => {
    if (words.length <= 1) return;
    const id = setInterval(() => setI((x) => (x + 1) % words.length), 2400);
    return () => clearInterval(id);
  }, [words.length]);

  // Keep the live reasoning preview pinned to its latest line.
  const reaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = reaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning]);

  const word = words[Math.min(i, words.length - 1)] ?? t('thinking.label');

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <ThinkingDots />
        {/* key forces a gentle fade each time the word changes */}
        <span key={`${word}-${i}`} className="motion-safe:animate-fade-in">
          {word}…
        </span>
      </div>
      {reasoning && reasoning.trim() ? (
        <div
          ref={reaRef}
          className="max-h-14 overflow-hidden whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground/60 [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
        >
          {reasoning.trim()}
        </div>
      ) : null}
    </div>
  );
}
