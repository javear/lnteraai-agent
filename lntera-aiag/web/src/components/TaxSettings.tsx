// "Tax profile" section of the Active Agent settings modal (shown when accounting is on). Per-tenant tax
// setup — NPWP, PPN registration + rate, and PPh withholding — used by the tax recap / planning docs.
// Nothing is hardcoded; defaults are just the common Indonesian values (PPN 11%, PPh 23 2%).
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button, Input } from '../ui';
import { Switch } from '@/components/ui/switch';
import { useT } from '../i18n';
import { getTaxProfile, putTaxProfile, type WithholdingRule } from '../lib/finance-config';

const COMMON_WITHHOLDING: { type: string; label: string; defaultRate?: number }[] = [
  { type: 'PPh21', label: 'PPh 21 (employees)' },
  { type: 'PPh23', label: 'PPh 23 (services)', defaultRate: 2 },
  { type: 'PPh22', label: 'PPh 22' },
  { type: 'PPh4(2)', label: 'PPh Final 4(2)' },
];

export function TaxSettings() {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const tr = useT(); // `tr` — COMMON_WITHHOLDING.map((t) => …) below binds `t`
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [npwp, setNpwp] = useState('');
  const [ppnEnabled, setPpnEnabled] = useState(false);
  const [ppnRate, setPpnRate] = useState(11);
  const [wh, setWh] = useState<Record<string, { enabled: boolean; rate?: number }>>({});

  useEffect(() => {
    let cancelled = false;
    getTaxProfile(api)
      .then((p) => {
        if (cancelled) return;
        setNpwp(p.npwp ?? '');
        setPpnEnabled(Boolean(p.config.ppnEnabled));
        setPpnRate(p.config.ppnRate ?? 11);
        const map: Record<string, { enabled: boolean; rate?: number }> = {};
        for (const w of p.config.withholding ?? []) map[w.type] = { enabled: true, rate: w.rate };
        setWh(map);
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
      const withholding: WithholdingRule[] = COMMON_WITHHOLDING.filter((t) => wh[t.type]?.enabled).map((t) => ({
        type: t.type,
        ...(wh[t.type]?.rate != null ? { rate: wh[t.type]!.rate } : t.defaultRate != null ? { rate: t.defaultRate } : {}),
      }));
      await putTaxProfile(api, { npwp: npwp.trim() || null, ppnEnabled, ppnRate, withholding });
      toast.success(tr('tax.saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr('tax.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium text-foreground">{tr('tax.title')}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{tr('tax.desc')}</p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-muted-foreground">NPWP</span>
        <Input value={npwp} onChange={(e) => setNpwp(e.target.value)} placeholder="01.234.567.8-901.000" disabled={loading} />
      </label>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">{tr('tax.pkp')}</div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{tr('tax.pkpDesc')}</p>
        </div>
        <Switch checked={ppnEnabled} onCheckedChange={setPpnEnabled} disabled={loading} aria-label={tr('tax.pkp')} />
      </div>
      {ppnEnabled ? (
        <label className="flex items-center gap-2 pl-1">
          <span className="text-[12px] text-muted-foreground">{tr('tax.ppnRate')}</span>
          <input
            type="number"
            min={0}
            step="any"
            value={ppnRate}
            onChange={(e) => setPpnRate(Number(e.target.value))}
            className="h-8 w-20 rounded-md border border-input bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      ) : null}

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-[12px] font-medium text-muted-foreground">{tr('tax.pph')}</span>
        {COMMON_WITHHOLDING.map((t) => {
          const cur = wh[t.type] ?? { enabled: false, rate: t.defaultRate };
          return (
            <div key={t.type} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-foreground">{t.label}</span>
              <div className="flex items-center gap-2">
                {cur.enabled ? (
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={cur.rate ?? ''}
                    placeholder="%"
                    onChange={(e) => setWh((m) => ({ ...m, [t.type]: { enabled: true, rate: Number(e.target.value) } }))}
                    className="h-7 w-16 rounded-md border border-input bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ) : null}
                <Switch
                  checked={cur.enabled}
                  onCheckedChange={(v) => setWh((m) => ({ ...m, [t.type]: { enabled: v, rate: m[t.type]?.rate ?? t.defaultRate } }))}
                  disabled={loading}
                  aria-label={t.label}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <Button onClick={onSave} disabled={loading || saving || !online}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {tr('tax.save')}
        </Button>
      </div>
    </div>
  );
}
