import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, Square, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOnlineStatus } from '@/lib/pwa';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  onConfig,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /** When provided, shows a subtle settings button inside the composer (Active Agent automation). */
  onConfig?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const online = useOnlineStatus();
  const t = useT();
  const disabled = streaming || !online;

  // Auto-grow up to a cap (smaller on mobile so the keyboard + list stay visible).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cap = window.matchMedia('(min-width: 640px)').matches ? 200 : 160;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [value]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  }

  return (
    <div className="border-t bg-background px-3 pt-3 pb-[max(0.85rem,env(safe-area-inset-bottom))] sm:px-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'flex items-end gap-2 rounded-2xl border bg-background p-1.5 shadow-sm transition-shadow',
            'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          )}
        >
          {onConfig ? (
            <Button
              size="icon"
              variant="ghost"
              type="button"
              className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              onClick={onConfig}
              aria-label={t('chat.composer.settings')}
              title={t('chat.composer.settings')}
            >
              <SlidersHorizontal className="h-5 w-5" />
            </Button>
          ) : null}
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={online ? t('chat.placeholder') : t('chat.placeholder.offline')}
            disabled={disabled}
            // 16px (text-base) keeps iOS Safari from auto-zooming on focus.
            className="flex-1 resize-none bg-transparent px-2.5 py-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          {streaming ? (
            <Button size="icon" variant="secondary" className="rounded-xl [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={onStop} aria-label={t('chat.stop')}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="rounded-xl [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              onClick={onSend}
              disabled={!value.trim() || disabled}
              aria-label={t('chat.send')}
            >
              <ArrowUp className="h-5 w-5" />
            </Button>
          )}
        </div>
        <p className="mt-1.5 hidden text-center text-xs text-muted-foreground sm:block">
          {online ? t('chat.hint.send') : t('chat.hint.offline')}
        </p>
      </div>
    </div>
  );
}
