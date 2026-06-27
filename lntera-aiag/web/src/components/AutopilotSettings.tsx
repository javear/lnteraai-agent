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
import { useT } from '../i18n';
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
  const t = useT();
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
      toast.success(t('auto.saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('auto.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-sm font-medium text-foreground">{t('auto.title')}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{t('auto.desc')}</p>
      </div>

      <ToggleRow
        label={t('auto.stock')}
        desc={t('auto.stockDesc')}
        checked={prefs.autopilotStock}
        disabled={loading}
        onChange={(v) => setPrefs((p) => ({ ...p, autopilotStock: v }))}
      />
      <ToggleRow
        label={t('auto.price')}
        desc={t('auto.priceDesc')}
        checked={prefs.autopilotPrice}
        disabled={loading}
        onChange={(v) => setPrefs((p) => ({ ...p, autopilotPrice: v }))}
      />

      <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={onSave} disabled={loading || saving || !online}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('common.save')}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {prefs.autopilotStock || prefs.autopilotPrice ? t('auto.on') : t('auto.notifyFirst')}
        </span>
      </div>
    </div>
  );
}
