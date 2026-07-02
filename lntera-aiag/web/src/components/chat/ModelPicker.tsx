import { useMemo } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { PinnableModel } from '@/lib/integrations';

/**
 * Compact, Claude/Cursor-style model pill: current model + chevron, opening a grouped dropdown
 * ("Auto" + models per provider, checkmarked selection). Shared by the business composer and Studio.
 */
export function ModelPicker({
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
