// "Automatic analysis" config body — rendered inside the Active Agent's config dialog. Enable +
// pick days + an exact hour:minute + which insights; Save persists to /svc/v1/insights/schedule.
// "Analyze now" triggers an immediate run that lands in the Active Agent chat.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Button } from '../ui';
import { Switch } from '@/components/ui/switch';
import {
  browserTimezone,
  formatNextRun,
  getInsightSchedule,
  putInsightSchedule,
  runInsightsNow,
  type InsightProviderInfo,
  type NextRun,
} from '../lib/insights';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function InsightSettings() {
  const { api } = useAuth();
  const online = useOnlineStatus();

  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState<InsightProviderInfo[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [timezone, setTimezone] = useState<string>(browserTimezone());
  const [nextRun, setNextRun] = useState<NextRun | null>(null);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getInsightSchedule(api);
        if (cancelled) return;
        setAvailable(res.availableInsights);
        setNextRun(res.nextRun ?? null);
        const allKeys = res.availableInsights.map((p) => p.key);
        const s = res.schedule;
        if (s) {
          setEnabled(s.enabled);
          setTime(/^\d{1,2}:\d{2}$/.test(s.localTime) ? s.localTime : '09:00');
          setDays(new Set(s.daysOfWeek));
          setTimezone(s.timezone || browserTimezone());
          setSelected(new Set(s.subscribedKeys ?? allKeys));
        } else {
          setSelected(new Set(allKeys)); // default: all
        }
      } catch {
        if (!cancelled) toast.error('Could not load automatic-analysis settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  function toggleDay(d: number) {
    setNextRun(null); // edited timing → recomputed on Save
    setDays((prev) => {
      const next = new Set(prev);
      next.has(d) ? next.delete(d) : next.add(d);
      return next;
    });
  }
  function toggleInsight(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function onSave() {
    if (enabled && days.size === 0) {
      toast.error('Pick at least one day.');
      return;
    }
    setSaving(true);
    try {
      const allSelected = selected.size === available.length;
      const { nextRun: nr } = await putInsightSchedule(api, {
        enabled,
        localTime: time,
        daysOfWeek: [...days].sort((a, b) => a - b),
        timezone,
        subscribedKeys: allSelected ? null : [...selected],
      });
      setNextRun(nr ?? null);
      if (!enabled) {
        toast.success('Automatic analysis turned off.');
      } else if (nr?.at) {
        const label = formatNextRun(nr.at, timezone);
        if (nr.firesToday) toast.success(`Saved — next analysis runs ${label}.`);
        else toast.success(`Saved — next analysis runs ${label}.`, { description: "It won't run again today." });
      } else {
        toast.success('Automatic analysis saved.');
      }
    } catch {
      toast.error('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function onRunNow() {
    setRunningNow(true);
    try {
      const r = await runInsightsNow(api);
      toast.success(r.message ?? 'Analyzing… results will appear here shortly.');
    } catch {
      toast.error('Could not start the analysis.');
    } finally {
      setRunningNow(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Automatic analysis</div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
            Analyze your shops on a schedule and post the highlights — with charts — here in the Active Agent.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            setNextRun(null);
            setEnabled(v);
          }}
          aria-label="Enable automatic analysis"
          disabled={loading}
        />
      </div>

      {!loading && enabled ? (
        <div className="flex flex-col gap-5 border-t pt-5">
          {/* Days */}
          <div>
            <div className="mb-2 text-[13px] font-medium">Days</div>
            <div className="flex gap-1.5">
              {DAY_LETTERS.map((letter, d) => {
                const on = days.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    title={DAY_NAMES[d]}
                    aria-pressed={on}
                    onClick={() => toggleDay(d)}
                    className={
                      'inline-flex h-9 w-9 items-center justify-center rounded-full border text-[13px] font-medium transition-colors ease-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
                      (on
                        ? 'border-transparent bg-brand text-brand-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground')
                    }
                  >
                    {letter}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time — exact hour:minute */}
          <div>
            <div className="mb-2 text-[13px] font-medium">Time</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                value={time}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setNextRun(null);
                  setTime(e.target.value);
                }}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              <span className="text-[13px] text-muted-foreground">in {timezone} · runs once per day</span>
            </div>
            {nextRun?.at ? (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Next analysis:{' '}
                <span className="font-medium text-foreground">{formatNextRun(nextRun.at, timezone)}</span>
                {nextRun.firesToday ? '' : ' · not today'}
              </p>
            ) : null}
          </div>

          {/* Insights */}
          <div>
            <div className="mb-2 text-[13px] font-medium">Insights</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {available.map((p) => (
                <label
                  key={p.key}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px] transition-colors ease-soft hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.key)}
                    onChange={() => toggleInsight(p.key)}
                    className="h-4 w-4 shrink-0 rounded border-input"
                  />
                  <span className="min-w-0 truncate">{p.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button onClick={onSave} disabled={loading || saving || !online}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
        <Button variant="secondary" onClick={onRunNow} disabled={loading || runningNow || !online}>
          {runningNow ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Analyze now
        </Button>
      </div>
    </div>
  );
}
