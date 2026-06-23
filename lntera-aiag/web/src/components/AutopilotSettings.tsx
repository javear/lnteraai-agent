// "Stock & price autopilot" config body — rendered inside the Active Agent's config dialog alongside
// InsightSettings. Toggling either attribute on enables autopilot mode (auto-push across mapped stores);
// both off = notify-first. Persists to /svc/v1/sync/autopilot.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button } from '../ui';
import { Switch } from '@/components/ui/switch';
import { getAutopilot, putAutopilot, type AutopilotPrefs } from '../lib/sync-config';

function ToggleRow({
  label,
  desc,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

export function AutopilotSettings() {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<AutopilotPrefs>({ autopilotStock: false, autopilotPrice: false, propagateMode: 'notify' });

  useEffect(() => {
    let cancelled = false;
    getAutopilot(api)
      .then((p) => {
        if (!cancelled) setPrefs(p);
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
    setSaving(true);
    try {
      const anyOn = prefs.autopilotStock || prefs.autopilotPrice;
      const saved = await putAutopilot(api, {
        autopilotStock: prefs.autopilotStock,
        autopilotPrice: prefs.autopilotPrice,
        propagateMode: anyOn ? 'autopilot' : 'notify',
      });
      setPrefs(saved);
      toast.success('Sync settings saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save sync settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-sm font-medium text-foreground">Stock &amp; price autopilot</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          When a product&apos;s stock or price changes on one store, apply it across your other mapped stores
          automatically. When off, I&apos;ll ask you first each time.
        </p>
      </div>

      <ToggleRow
        label="Auto-sync stock"
        desc="A sale on one store reduces the others too (each store keeps its stock cap)."
        checked={prefs.autopilotStock}
        disabled={loading}
        onChange={(v) => setPrefs((p) => ({ ...p, autopilotStock: v }))}
      />
      <ToggleRow
        label="Auto-sync price"
        desc="A price change pushes to every store with that store's margin applied."
        checked={prefs.autopilotPrice}
        disabled={loading}
        onChange={(v) => setPrefs((p) => ({ ...p, autopilotPrice: v }))}
      />

      <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={onSave} disabled={loading || saving || !online}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {prefs.autopilotStock || prefs.autopilotPrice ? 'Autopilot on' : 'Notify-first'}
        </span>
      </div>
    </div>
  );
}
