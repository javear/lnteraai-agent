import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, Square, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useOnlineStatus } from '@/lib/pwa';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PinnableModel } from '@/lib/integrations';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  onConfig,
  models,
  pinnedModel,
  onPinModel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /** When provided, shows a subtle settings button inside the composer (Active Agent automation). */
  onConfig?: () => void;
  /** Models the tenant can pin for this run. When present, a picker is shown ("Auto" + models). */
  models?: PinnableModel[];
  /** Currently pinned model code ('' = Auto / default round-robin). */
  pinnedModel?: string;
  onPinModel?: (modelCode: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const online = useOnlineStatus();
  const t = useT();
  const disabled = streaming || !online;
  const showPicker = Boolean(models && models.length > 0 && onPinModel);

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
            'rounded-2xl border bg-background shadow-sm transition-shadow',
            'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={online ? t('chat.placeholder') : t('chat.placeholder.offline')}
            disabled={disabled}
            // 16px (text-base) keeps iOS Safari from auto-zooming on focus.
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />

          {/* Action bar — left tools, right send. Mirrors the Claude/Cursor composer layout. */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            {onConfig ? (
              <Button
                size="icon"
                variant="ghost"
                type="button"
                className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
                onClick={onConfig}
                aria-label={t('chat.composer.settings')}
                title={t('chat.composer.settings')}
              >
                <SlidersHorizontal className="h-[18px] w-[18px]" />
              </Button>
            ) : null}

            <div className="ml-auto flex items-center gap-1">
              {showPicker ? (
                <ModelPicker
                  models={models!}
                  pinnedModel={pinnedModel ?? ''}
                  onPinModel={onPinModel!}
                  disabled={streaming}
                  autoLabel={label(t, 'chat.model.auto', 'Auto')}
                  headingLabel={label(t, 'chat.model', 'Model')}
                />
              ) : null}
              {streaming ? (
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-9 w-9 rounded-xl [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                  onClick={onStop}
                  aria-label={t('chat.stop')}
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="h-9 w-9 rounded-xl [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                  onClick={onSend}
                  disabled={!value.trim() || disabled}
                  aria-label={t('chat.send')}
                >
                  <ArrowUp className="h-5 w-5" />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-1.5 hidden text-center text-xs text-muted-foreground sm:block">
          {online ? t('chat.hint.send') : t('chat.hint.offline')}
        </p>
      </div>
    </div>
  );
}

/** Compact, Claude/Cursor-style model pill: current model + chevron, opening a grouped dropdown. */
function ModelPicker({
  models,
  pinnedModel,
  onPinModel,
  disabled,
  autoLabel,
  headingLabel,
}: {
  models: PinnableModel[];
  pinnedModel: string;
  onPinModel: (modelCode: string) => void;
  disabled: boolean;
  autoLabel: string;
  headingLabel: string;
}) {
  const groups = useMemo(() => {
    const byProvider = new Map<string, PinnableModel[]>();
    for (const m of models) {
      const arr = byProvider.get(m.providerName) ?? [];
      arr.push(m);
      byProvider.set(m.providerName, arr);
    }
    return [...byProvider.entries()];
  }, [models]);

  const selected = models.find((m) => m.modelCode === pinnedModel);
  const triggerLabel = selected ? selected.segment : autoLabel;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={headingLabel}
          className={cn(
            'inline-flex max-w-[10rem] items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium sm:max-w-[16rem]',
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:py-1.5',
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[55vh] w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onPinModel('')}>
          <Check className={cn('h-4 w-4 text-primary', pinnedModel ? 'opacity-0' : 'opacity-100')} />
          <span className="flex-1">{autoLabel}</span>
          <span className="text-[11px] text-muted-foreground">default</span>
        </DropdownMenuItem>
        {groups.map(([provider, items]) => (
          <div key={provider}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{provider}</DropdownMenuLabel>
            {items.map((m) => {
              const isSelected = m.modelCode === pinnedModel;
              return (
                <DropdownMenuItem key={m.modelCode} onSelect={() => onPinModel(m.modelCode)}>
                  <Check className={cn('h-4 w-4 text-primary', isSelected ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{m.segment}</span>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** i18n with an English fallback when the key is missing (t() returns the key unchanged). */
function label(t: (k: string) => string, key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}
