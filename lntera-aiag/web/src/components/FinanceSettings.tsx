// "Accounting & finance" section of the Active Agent settings modal. The master on/off toggle for the
// advanced finance module (double-entry ledger + tax) — not every business needs it. Transaction
// recording stays on regardless. Enabling seeds a default chart of accounts + back-posts existing
// transactions. When on, the Tax profile section below it becomes meaningful.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Switch } from '@/components/ui/switch';
import { useT } from '../i18n';
import { getFinanceSettings, putFinanceSettings } from '../lib/finance-config';

export function FinanceSettings({ onChange }: { onChange?: (enabled: boolean) => void }) {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFinanceSettings(api)
      .then((s) => {
        if (!cancelled) {
          setEnabled(s.accountingEnabled);
          onChange?.(s.accountingEnabled);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      const res = await putFinanceSettings(api, next);
      setEnabled(res.accountingEnabled);
      onChange?.(res.accountingEnabled);
      if (next) {
        const posted = res.backfill?.posted ?? 0;
        toast.success(posted > 0 ? t('fin.onPosted', { n: posted }) : t('fin.on'));
      } else {
        toast.success(t('fin.off'));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('fin.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-foreground">{t('fin.title')}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{t('fin.desc')}</p>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">{t('fin.enable')}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{t('fin.enableDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <Switch checked={enabled} disabled={loading || saving || !online} onCheckedChange={toggle} aria-label={t('fin.enable')} />
        </div>
      </div>
    </div>
  );
}
