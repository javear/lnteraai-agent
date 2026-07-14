import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { ArrowUp, FileText, Paperclip, Square, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { useOnlineStatus } from '@/lib/pwa';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PinnableModel } from '@/lib/integrations';
import { ALLOWED_KNOWLEDGE_EXTENSIONS, formatBytes, validateKnowledgeFile } from '@/lib/knowledge';

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
  attachedFile,
  onAttach,
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
  /** A document staged to upload as knowledge alongside the next message. */
  attachedFile?: File | null;
  onAttach?: (file: File | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const online = useOnlineStatus();
  const t = useT();
  const disabled = streaming || !online;
  const showPicker = Boolean(models && models.length > 0 && onPinModel);
  const canSend = (value.trim() || attachedFile) && !disabled;

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onAttach) return;
    const error = validateKnowledgeFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    onAttach(file);
  }

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
      if (canSend) onSend();
    }
  }

  return (
    <div className="border-t bg-background px-3 pt-3 pb-[max(0.85rem,env(safe-area-inset-bottom))] sm:px-4">
      <div className="mx-auto max-w-3xl">
        {attachedFile ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-[13px]">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{attachedFile.name}</span>
            <span className="shrink-0 text-muted-foreground">{formatBytes(attachedFile.size)}</span>
            <button
              type="button"
              onClick={() => onAttach?.(null)}
              className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Remove attachment"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
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
            {onAttach ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ALLOWED_KNOWLEDGE_EXTENSIONS.join(',')}
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  type="button"
                  className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || Boolean(attachedFile)}
                  aria-label="Attach a document"
                  title="Attach a document to add to your knowledge base"
                >
                  <Paperclip className="h-[18px] w-[18px]" />
                </Button>
              </>
            ) : null}
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
                  disabled={!canSend}
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

/** i18n with an English fallback when the key is missing (t() returns the key unchanged). */
function label(t: (k: string) => string, key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}
