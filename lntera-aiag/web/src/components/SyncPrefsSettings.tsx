// "Product recognition" card for the Integrations page — surfaces tenant_sync_prefs (which had no UI):
// auto-add new products, auto-link high-confidence matches, and the match thresholds.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button, Card } from '../ui';
import { Switch } from '@/components/ui/switch';
import { getRecognitionPrefs, putRecognitionPrefs, type RecognitionPrefs } from '../lib/sync-config';

function Toggle({
  label,
  desc,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {desc ? <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{desc}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        min={0.05}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

export function SyncPrefsSettings() {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [p, setP] = useState<RecognitionPrefs>({
    autoCreateNew: false,
    autoMapHighConfidence: false,
    highThreshold: 0.9,
    mediumThreshold: 0.6,
  });

  useEffect(() => {
    let cancelled = false;
    getRecognitionPrefs(api)
      .then((r) => {
        if (!cancelled) setP(r);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function onSave() {
    if (p.mediumThreshold > p.highThreshold) {
      toast.error('Medium threshold cannot exceed the high threshold.');
      return;
    }
    setSaving(true);
    try {
      const saved = await putRecognitionPrefs(api, p);
      setP(saved);
      toast.success('Recognition preferences saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save preferences.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">Product recognition</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            How new marketplace listings are matched to your master catalog.
          </p>
        </div>
        <Toggle
          label="Auto-add unrecognized products"
          desc="Create a master product automatically when no good match is found."
          checked={p.autoCreateNew}
          disabled={loading}
          onChange={(v) => setP((s) => ({ ...s, autoCreateNew: v }))}
        />
        <Toggle
          label="Auto-link high-confidence matches"
          desc="Skip the prompt when a match scores above the high threshold."
          checked={p.autoMapHighConfidence}
          disabled={loading}
          onChange={(v) => setP((s) => ({ ...s, autoMapHighConfidence: v }))}
        />
        {p.autoMapHighConfidence ? (
          <div className="grid grid-cols-2 gap-3 border-t pt-3">
            <NumField label="High threshold" value={p.highThreshold} onChange={(v) => setP((s) => ({ ...s, highThreshold: v }))} />
            <NumField label="Medium threshold" value={p.mediumThreshold} onChange={(v) => setP((s) => ({ ...s, mediumThreshold: v }))} />
          </div>
        ) : null}
        <div>
          <Button onClick={onSave} disabled={loading || saving || !online}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
