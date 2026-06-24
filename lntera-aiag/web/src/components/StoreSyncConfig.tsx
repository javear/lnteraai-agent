// Per-store one-directional transform editor (internal → this store): a dynamic stack of price
// adjustments (each percent-of-base or a fixed amount) plus a stock cap %. Rendered (collapsed) under
// each store row in Integrations. The live preview uses the same math the server pushes with
// (lib/sync-config computePushed*).
import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button } from '../ui';
import {
  computePushedPrice,
  computePushedStock,
  putStore,
  type PriceAdjustment,
  type StoreSyncRow,
} from '../lib/sync-config';

const SAMPLE_BASE = 100000;
const SAMPLE_STOCK = 100;

export function StoreSyncConfig({ store, onSaved }: { store: StoreSyncRow; onSaved?: (s: StoreSyncRow) => void }) {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adjustments, setAdjustments] = useState<PriceAdjustment[]>(() => store.priceAdjustments ?? []);
  const [cap, setCap] = useState(String(store.stockCapPct));

  const n = (v: string) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const capCur = store.feeCurrency;
  const fmt = (v: number) =>
    new Intl.NumberFormat(
      undefined,
      capCur ? { style: 'currency', currency: capCur, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 },
    ).format(v);

  const previewPrice = computePushedPrice(SAMPLE_BASE, adjustments, capCur);
  const previewStock = computePushedStock(SAMPLE_STOCK, n(cap));

  function updateAdj(i: number, patch: Partial<PriceAdjustment>) {
    setAdjustments((list) => list.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAdj(kind: PriceAdjustment['kind']) {
    setAdjustments((list) => [...list, { kind, value: 0 }]);
  }
  function removeAdj(i: number) {
    setAdjustments((list) => list.filter((_, idx) => idx !== i));
  }

  async function onSave() {
    const capN = n(cap);
    if (capN <= 0 || capN > 100) {
      toast.error('Stock cap must be between 1 and 100%.');
      return;
    }
    for (const a of adjustments) {
      if (!Number.isFinite(a.value)) {
        toast.error('Every adjustment needs a number.');
        return;
      }
      if (a.kind === 'percent' && (a.value <= -100 || a.value > 1000)) {
        toast.error('A percent must be between -100 and 1000.');
        return;
      }
    }
    setSaving(true);
    try {
      const saved = await putStore(api, store.connectionId, {
        priceAdjustments: adjustments.map((a) => ({
          kind: a.kind,
          value: a.value,
          ...(a.label?.trim() ? { label: a.label.trim() } : {}),
        })),
        stockCapPct: capN,
      });
      onSaved?.(saved);
      setAdjustments(saved.priceAdjustments ?? []);
      toast.success('Store sync settings saved.');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save store settings.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Price adjustments &amp; stock cap →
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">
            Price adjustments {capCur ? `(fixed in ${capCur})` : ''}
          </span>
        </div>

        {adjustments.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No markup — this store gets the internal price as-is.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {adjustments.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={a.kind}
                  onChange={(e) => updateAdj(i, { kind: e.target.value as PriceAdjustment['kind'] })}
                  className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Adjustment type"
                >
                  <option value="percent">%</option>
                  <option value="fixed">Fixed</option>
                </select>
                <input
                  type="number"
                  step="any"
                  value={a.value}
                  onChange={(e) => updateAdj(i, { value: Number(e.target.value) })}
                  className="h-8 w-20 shrink-0 rounded-md border border-input bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Adjustment value"
                />
                <input
                  type="text"
                  value={a.label ?? ''}
                  placeholder="Label (optional)"
                  onChange={(e) => updateAdj(i, { label: e.target.value })}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Adjustment label"
                />
                <button
                  type="button"
                  onClick={() => removeAdj(i)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                  aria-label="Remove adjustment"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => addAdj('percent')}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[12px] text-foreground hover:bg-accent"
          >
            <Plus className="h-3 w-3" /> Percent
          </button>
          <button
            type="button"
            onClick={() => addAdj('fixed')}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[12px] text-foreground hover:bg-accent"
          >
            <Plus className="h-3 w-3" /> Fixed amount
          </button>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Stock cap %</span>
        <input
          type="number"
          min={1}
          max={100}
          step="any"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div className="rounded-md bg-background px-3 py-2 text-[12px] text-muted-foreground">
        Push preview: price {fmt(SAMPLE_BASE)} → <span className="font-medium text-foreground">{fmt(previewPrice)}</span> · stock{' '}
        {SAMPLE_STOCK} → <span className="font-medium text-foreground">{previewStock}</span>
      </div>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving || !online}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
