// Per-store one-directional transform editor (internal → this store): price margin (flat + up% +
// other%) and stock cap %. Rendered (collapsed) under each store row in Integrations. The live preview
// uses the same math the server pushes with (lib/sync-config computePushed*).
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button } from '../ui';
import { computePushedPrice, computePushedStock, putStore, type StoreSyncRow } from '../lib/sync-config';

const SAMPLE_BASE = 100000;
const SAMPLE_STOCK = 100;

function Num({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

export function StoreSyncConfig({ store, onSaved }: { store: StoreSyncRow; onSaved?: (s: StoreSyncRow) => void }) {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flat, setFlat] = useState(String(store.priceFeeFlat));
  const [up, setUp] = useState(String(store.priceFeeUpPct));
  const [other, setOther] = useState(String(store.priceFeeOtherPct));
  const [cap, setCap] = useState(String(store.stockCapPct));

  const n = (v: string) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  const fmt = (v: number) =>
    new Intl.NumberFormat(
      undefined,
      store.feeCurrency ? { style: 'currency', currency: store.feeCurrency, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 },
    ).format(v);

  const previewPrice = computePushedPrice(SAMPLE_BASE, { priceFeeFlat: n(flat), priceFeeUpPct: n(up), priceFeeOtherPct: n(other) }, store.feeCurrency);
  const previewStock = computePushedStock(SAMPLE_STOCK, n(cap));

  async function onSave() {
    const capN = n(cap);
    if (capN <= 0 || capN > 100) {
      toast.error('Stock cap must be between 1 and 100%.');
      return;
    }
    if (n(flat) < 0 || n(up) < 0 || n(other) < 0) {
      toast.error('Fees must be 0 or more.');
      return;
    }
    setSaving(true);
    try {
      const saved = await putStore(api, store.connectionId, {
        priceFeeFlat: n(flat),
        priceFeeUpPct: n(up),
        priceFeeOtherPct: n(other),
        stockCapPct: capN,
      });
      onSaved?.(saved);
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
        Margins &amp; stock cap →
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Num label={`Flat fee${store.feeCurrency ? ` (${store.feeCurrency})` : ''}`} value={flat} onChange={setFlat} />
        <Num label="Up %" value={up} onChange={setUp} />
        <Num label="Other %" value={other} onChange={setOther} />
        <Num label="Stock cap %" value={cap} onChange={setCap} />
      </div>
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
