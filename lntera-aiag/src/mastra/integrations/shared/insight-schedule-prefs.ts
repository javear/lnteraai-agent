// Per-tenant "automatic insights" schedule: read/write the single schedule row (free tier = one per
// tenant, mirroring sync-prefs.ts) and resolve which tenants are DUE on the current dispatcher tick.
// Times are stored as an exact local 'HH:MM' (any hour:minute) + weekdays + IANA timezone; the due
// check is DST-safe via Intl, fires once per local day at/after the chosen time, and a once/day guard
// compares the last run's LOCAL date.
import { getSupabase } from './supabase';

const TABLE = 'tenant_insight_schedules';
const SCHEDULE_COLS =
  'id, tenant_id, enabled, local_time, days_of_week, timezone, subscribed_keys, last_run_at, next_run_at';

/** Timezone fallback when neither the schedule nor tenant_master sets one (SEA seller base). */
export const DEFAULT_TIMEZONE = 'Asia/Jakarta';

/**
 * Opt-in (env `INSIGHTS_REARM_ON_EDIT`): when a tenant changes their schedule's TIME or DAYS, clear
 * the "already ran today" mark so a new future time today fires TODAY instead of the next selected
 * day. Off by default to keep the free-tier one-run-per-day guarantee. Accepts 1/true/yes/on.
 */
export function insightsRearmOnEdit(): boolean {
  const v = (process.env.INSIGHTS_REARM_ON_EDIT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface ResolvedInsightSchedule {
  id: string;
  tenantId: string;
  enabled: boolean;
  localTime: string; // 'HH:MM' — any exact hour:minute
  daysOfWeek: number[]; // ISO 0..6 (Sun..Sat)
  timezone: string | null;
  subscribedKeys: string[] | null; // null = all default-on providers
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface ScheduleRow {
  id: string;
  tenant_id: string;
  enabled: boolean;
  local_time: string;
  days_of_week: number[] | null;
  timezone: string | null;
  subscribed_keys: unknown;
  last_run_at: string | null;
  next_run_at: string | null;
}

function rowToResolved(r: ScheduleRow): ResolvedInsightSchedule {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    enabled: Boolean(r.enabled),
    localTime: normalizeLocalTime(r.local_time),
    daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week : [],
    timezone: r.timezone,
    subscribedKeys: Array.isArray(r.subscribed_keys) ? (r.subscribed_keys as string[]) : null,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

/** Validate + zero-pad an 'HH:MM' (any hour:minute — no rounding). */
export function normalizeLocalTime(value: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((value ?? '').trim());
  if (!m) return '09:00';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export async function getInsightSchedule(tenantId: string): Promise<ResolvedInsightSchedule | null> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('id, tenant_id, enabled, local_time, days_of_week, timezone, subscribed_keys, last_run_at, next_run_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read insight schedule: ${error.message}`);
  return data ? rowToResolved(data as ScheduleRow) : null;
}

export interface InsightSchedulePatch {
  enabled?: boolean;
  localTime?: string;
  daysOfWeek?: number[];
  timezone?: string | null;
  subscribedKeys?: string[] | null;
}

/** Upsert the tenant's single schedule row (read-then-write; one row per tenant). */
export async function setInsightSchedule(
  tenantId: string,
  patch: InsightSchedulePatch,
): Promise<ResolvedInsightSchedule> {
  const supabase = getSupabase();
  const { data: existingRow, error: readErr } = await supabase
    .from(TABLE)
    .select(SCHEDULE_COLS)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (readErr) throw new Error(`Failed to read insight schedule: ${readErr.message}`);
  const existing = existingRow ? rowToResolved(existingRow as ScheduleRow) : null;

  const fields: Record<string, unknown> = {};
  if (patch.enabled !== undefined) fields.enabled = patch.enabled;
  if (patch.localTime !== undefined) fields.local_time = normalizeLocalTime(patch.localTime);
  if (patch.daysOfWeek !== undefined) fields.days_of_week = sanitizeDays(patch.daysOfWeek);
  if (patch.timezone !== undefined) fields.timezone = patch.timezone;
  if (patch.subscribedKeys !== undefined) fields.subscribed_keys = patch.subscribedKeys;

  // Opt-in re-arm: changing the time/days clears today's run mark so a new future time fires today.
  const timingChanged = patch.localTime !== undefined || patch.daysOfWeek !== undefined;
  let effectiveLastRun = existing?.lastRunAt ?? null;
  if (insightsRearmOnEdit() && timingChanged) {
    fields.last_run_at = null;
    effectiveLastRun = null;
  }

  // Compute next_run_at from the POST-write schedule so the column + UI always reflect reality.
  const projected = {
    enabled: patch.enabled ?? existing?.enabled ?? true,
    localTime: normalizeLocalTime(patch.localTime ?? existing?.localTime ?? '09:00'),
    daysOfWeek: patch.daysOfWeek !== undefined ? sanitizeDays(patch.daysOfWeek) : existing?.daysOfWeek ?? [],
    timezone: patch.timezone !== undefined ? patch.timezone : existing?.timezone ?? null,
    lastRunAt: effectiveLastRun,
  };
  const next = nextRunFor(projected, new Date());
  fields.next_run_at = next.at ? next.at.toISOString() : null;

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update(fields)
      .eq('id', existing.id)
      .select(SCHEDULE_COLS)
      .single();
    if (error) throw new Error(`Failed to update insight schedule: ${error.message}`);
    return rowToResolved(data as ScheduleRow);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ tenant_id: tenantId, ...fields })
    .select(SCHEDULE_COLS)
    .single();
  if (error) throw new Error(`Failed to insert insight schedule: ${error.message}`);
  return rowToResolved(data as ScheduleRow);
}

function sanitizeDays(days: number[]): number[] {
  const set = new Set<number>();
  for (const d of days) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** Mark a schedule as having run at `ranAt` (sets last_run_at; the once/day guard reads it). */
export async function markScheduleRan(scheduleId: string, ranAt: Date): Promise<void> {
  const { error } = await getSupabase()
    .from(TABLE)
    .update({ last_run_at: ranAt.toISOString() })
    .eq('id', scheduleId);
  if (error) throw new Error(`Failed to mark schedule ran: ${error.message}`);
}

export interface DueSchedule {
  tenantId: string;
  scheduleId: string;
  /** Deterministic per-day key (scheduleId-YYYY-MM-DD local) for once/day idempotency end-to-end. */
  slotKey: string;
  subscribedKeys: string[] | null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface LocalParts {
  weekday: number;
  /** Local minutes-of-day (hour*60 + minute). */
  minutes: number;
  /** Local date YYYY-MM-DD. */
  ymd: string;
}

/** Break a Date into LOCAL parts for an IANA timezone (DST-safe via Intl). */
export function localPartsFor(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  const hour = get('hour') === '24' ? 0 : Number(get('hour')); // Intl can emit 24 at midnight
  const minutes = hour * 60 + Number(get('minute'));
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  return { weekday, minutes, ymd };
}

export function effectiveTimezone(schedule: { timezone: string | null }, tenantTz: string | null): string {
  return (schedule.timezone || tenantTz || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
}

/** Milliseconds the IANA `timeZone` is offset from UTC at `date` (DST-aware via Intl). */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUTC - date.getTime();
}

/** UTC instant for a local wall time ('HH:MM' on a YYYY-MM-DD civil date) in an IANA timezone. */
function zonedWallTimeToUtc(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two-pass: correct the guess by the tz offset at the corrected instant (handles offset self-ref).
  const off1 = tzOffsetMs(timeZone, new Date(guess));
  const off2 = tzOffsetMs(timeZone, new Date(guess - off1));
  return new Date(guess - off2);
}

export interface NextRun {
  /** When the schedule next fires, or null if disabled / no days selected. */
  at: Date | null;
  /** True when the next run lands on the local day of `now` (false ⇒ a later day). */
  firesToday: boolean;
}

/**
 * Resolve when a schedule will NEXT fire, mirroring listDueSchedules' rules exactly (DST-safe). Looks
 * at today first (unless it already ran today), then the next selected weekday within a week.
 */
export function nextRunFor(
  schedule: { enabled: boolean; localTime: string; daysOfWeek: number[]; timezone: string | null; lastRunAt: string | null },
  now: Date,
  tenantTz: string | null = null,
): NextRun {
  if (!schedule.enabled || schedule.daysOfWeek.length === 0) return { at: null, firesToday: false };
  const tz = effectiveTimezone(schedule, tenantTz);
  const target = timeToMinutes(schedule.localTime);
  const nowLocal = localPartsFor(now, tz);
  const ranToday =
    !!schedule.lastRunAt && localPartsFor(new Date(schedule.lastRunAt), tz).ymd === nowLocal.ymd;

  const [y, m, d] = nowLocal.ymd.split('-').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const civ = new Date(Date.UTC(y, m - 1, d + offset)); // civil-date arithmetic, tz/DST-independent
    const weekday = civ.getUTCDay(); // 0..6 Sun..Sat — matches our weekday index
    if (!schedule.daysOfWeek.includes(weekday)) continue;
    const ymd = `${civ.getUTCFullYear()}-${String(civ.getUTCMonth() + 1).padStart(2, '0')}-${String(
      civ.getUTCDate(),
    ).padStart(2, '0')}`;
    if (offset === 0) {
      if (ranToday) continue; // already ran today → next selected day
      // Fires today: at the target time, or on the next tick if the target already passed.
      const at = nowLocal.minutes >= target ? now : zonedWallTimeToUtc(ymd, schedule.localTime, tz);
      return { at, firesToday: true };
    }
    return { at: zonedWallTimeToUtc(ymd, schedule.localTime, tz), firesToday: false };
  }
  return { at: null, firesToday: false };
}

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

/** Human label for the next run ("today at 9:00 AM" / "tomorrow at …" / "Thursday at …" / "shortly"). */
export function describeNextRun(
  schedule: { enabled: boolean; localTime: string; daysOfWeek: number[]; timezone: string | null; lastRunAt: string | null },
  now: Date,
  tenantTz: string | null = null,
): NextRun & { label: string | null } {
  const next = nextRunFor(schedule, now, tenantTz);
  if (!next.at) return { ...next, label: null };
  const tz = effectiveTimezone(schedule, tenantTz);
  const nowLocal = localPartsFor(now, tz);
  const atLocal = localPartsFor(next.at, tz);

  // Imminent (target already passed today) → it's about to run on the next tick.
  if (next.firesToday && nowLocal.minutes >= timeToMinutes(schedule.localTime)) {
    return { ...next, label: 'shortly' };
  }

  const [y, m, d] = nowLocal.ymd.split('-').map(Number);
  const tom = new Date(Date.UTC(y, m - 1, d + 1));
  const tomYmd = `${tom.getUTCFullYear()}-${String(tom.getUTCMonth() + 1).padStart(2, '0')}-${String(
    tom.getUTCDate(),
  ).padStart(2, '0')}`;
  let day: string;
  if (atLocal.ymd === nowLocal.ymd) day = 'today';
  else if (atLocal.ymd === tomYmd) day = 'tomorrow';
  else day = DAY_FULL[atLocal.weekday];
  return { ...next, label: `${day} at ${to12h(schedule.localTime)}` };
}

/**
 * Tenants whose schedule fires on the dispatcher tick containing `now`. A schedule is due when it's
 * enabled, today's local weekday is selected, the current local time is at/after its chosen local_time,
 * and it hasn't already run today (last run's LOCAL date differs).
 */
export async function listDueSchedules(now: Date): Promise<DueSchedule[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('id, tenant_id, enabled, local_time, days_of_week, timezone, subscribed_keys, last_run_at, next_run_at, tenant_master(timezone)')
    .eq('enabled', true);
  if (error) throw new Error(`Failed to list insight schedules: ${error.message}`);

  const due: DueSchedule[] = [];
  // PostgREST embeds the to-one parent as an object or a single-element array depending on FK
  // detection — normalize both.
  const rows = ((data ?? []) as unknown) as Array<
    ScheduleRow & { tenant_master?: { timezone: string | null } | Array<{ timezone: string | null }> | null }
  >;
  for (const raw of rows) {
    const schedule = rowToResolved(raw);
    const tm = Array.isArray(raw.tenant_master) ? raw.tenant_master[0] : raw.tenant_master;
    const tz = effectiveTimezone(schedule, tm?.timezone ?? null);
    const nowLocal = localPartsFor(now, tz);

    if (!schedule.daysOfWeek.includes(nowLocal.weekday)) continue;
    // Fire on the first tick at/after the chosen local time, once per local day. Honors any HH:MM
    // (no slot rounding) and self-heals if a dispatcher tick is missed.
    if (nowLocal.minutes < timeToMinutes(schedule.localTime)) continue;
    if (schedule.lastRunAt) {
      const lastLocal = localPartsFor(new Date(schedule.lastRunAt), tz);
      if (lastLocal.ymd === nowLocal.ymd) continue; // already ran today
    }
    due.push({
      tenantId: schedule.tenantId,
      scheduleId: schedule.id,
      slotKey: `${schedule.id}-${nowLocal.ymd}`,
      subscribedKeys: schedule.subscribedKeys,
    });
  }
  return due;
}
