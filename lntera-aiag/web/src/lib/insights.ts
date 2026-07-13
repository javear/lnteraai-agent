// Typed client for the automatic-insights settings (`/svc/v1/insights/*`) + the shared ChartSpec
// contract the server delivers on insight notifications (mirrors src/mastra/insights/types.ts).
type Api = (path: string, init?: RequestInit) => Promise<Response>;

export interface ChartSpec {
  type: 'bar' | 'line' | 'donut' | 'forecast';
  title: string;
  unit?: string;
  labels: string[];
  series: Array<{ name?: string; data: number[] }>;
  /** For type 'forecast': the index in `labels`/`data` where projected (vs. historical) values begin. */
  forecastFromIndex?: number;
}

export interface InsightProviderInfo {
  key: string;
  label: string;
  defaultEnabled: boolean;
}

export interface InsightSchedule {
  id: string;
  tenantId: string;
  enabled: boolean;
  localTime: string; // 'HH:MM'
  daysOfWeek: number[]; // 0..6 (Sun..Sat)
  timezone: string | null;
  subscribedKeys: string[] | null; // null = all
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface NextRun {
  /** ISO timestamp of the next run, or null if disabled / no days selected. */
  at: string | null;
  /** True when the next run is on the current local day (false ⇒ a later day). */
  firesToday: boolean;
}

export interface InsightScheduleResponse {
  schedule: InsightSchedule | null;
  availableInsights: InsightProviderInfo[];
  nextRun?: NextRun;
}

export interface InsightSchedulePatch {
  enabled?: boolean;
  localTime?: string;
  daysOfWeek?: number[];
  timezone?: string | null;
  subscribedKeys?: string[] | null;
}

const BASE = '/svc/v1/insights';

export async function getInsightSchedule(api: Api): Promise<InsightScheduleResponse> {
  const res = await api(`${BASE}/schedule`);
  if (!res.ok) throw new Error(`Failed to load insight schedule (${res.status}).`);
  return (await res.json()) as InsightScheduleResponse;
}

export async function putInsightSchedule(
  api: Api,
  patch: InsightSchedulePatch,
): Promise<{ schedule: InsightSchedule; nextRun?: NextRun }> {
  const res = await api(`${BASE}/schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to save insight schedule (${res.status}).`);
  const data = (await res.json()) as { schedule: InsightSchedule; nextRun?: NextRun };
  return { schedule: data.schedule, nextRun: data.nextRun };
}

/** Locale-aware label for a next-run ISO timestamp ("today at 2:00 PM" / "tomorrow …" / weekday). */
export function formatNextRun(at: string, timeZone: string): string {
  const d = new Date(at);
  const ymd = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const now = new Date();
  const target = ymd(d);
  const time = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  let day: string;
  if (target === ymd(now)) day = 'today';
  else if (target === ymd(new Date(now.getTime() + 86_400_000))) day = 'tomorrow';
  else day = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(d);
  return `${day} at ${time}`;
}

export async function runInsightsNow(api: Api): Promise<{ ok: boolean; message?: string }> {
  const res = await api(`${BASE}/run-now`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start analysis (${res.status}).`);
  return (await res.json()) as { ok: boolean; message?: string };
}

/** Browser IANA timezone (e.g. 'Asia/Jakarta') for prefilling the schedule. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';
  } catch {
    return 'Asia/Jakarta';
  }
}
