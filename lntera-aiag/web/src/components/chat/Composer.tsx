import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOnlineStatus } from '@/lib/pwa';
import { cn } from '@/lib/utils';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const online = useOnlineStatus();
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
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={online ? 'Message your business agent…' : "You're offline — reconnect to chat"}
            disabled={disabled}
            // 16px (text-base) keeps iOS Safari from auto-zooming on focus.
            className="flex-1 resize-none bg-transparent px-2.5 py-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          {streaming ? (
            <Button size="icon" variant="secondary" className="rounded-xl" onClick={onStop} aria-label="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="rounded-xl"
              onClick={onSend}
              disabled={!value.trim() || disabled}
              aria-label="Send"
            >
              <ArrowUp className="h-5 w-5" />
            </Button>
          )}
        </div>
        <p className="mt-1.5 hidden text-center text-xs text-muted-foreground sm:block">
          {online ? 'Enter to send · Shift+Enter for a new line' : 'Reconnect to send messages'}
        </p>
      </div>
    </div>
  );
}
