// Per-tenant "future action" tasks for the Active Agent: store the natural-language instruction + an
// absolute fire time (one-shot) or a recurring schedule (days-of-week + local time, reusing the
// Insight schedule's exact recurrence model), list/cancel/resolve them, and turn a user's phrasing
// ("10am tomorrow", "in 2 hours", "every morning at 8am") into a concrete schedule.
//
// Up to MAX_ACTIVE_TASKS active tasks per tenant (enforced here in application code, not a DB
// constraint — a per-tenant row COUNT cap isn't cleanly expressible as a unique index). Scheduling
// itself is event-driven — see inngest/arm-scheduled-task.ts. The DB `status` is the authority that
// prevents a double-run; for a recurring task, `run_at`/`next_run_at` are advanced to the next
// occurrence (and the task re-armed) instead of the row going terminal.
import { getSupabase } from './supabase';
import {
  DEFAULT_TIMEZONE,
  effectiveTimezone,
  localPartsFor,
  nextRunFor,
  resolveTenantTimezone,
  zonedWallTimeToUtc,
} from './insight-schedule-prefs';

const TABLE = 'tenant_scheduled_tasks';
const COLS =
  'id, tenant_id, prompt, run_at, timezone, status, last_result, last_error, last_run_at, kind, local_time, days_of_week, next_run_at';

/** Furthest out a one-shot task may be scheduled (keeps the delayed Inngest event within a sane bound). */
export const MAX_HORIZON_DAYS = 60;

/** Up to this many active (status='scheduled') tasks per tenant, one-shot + recurring combined. */
export const MAX_ACTIVE_TASKS = 10;

export type ScheduledTaskStatus = 'scheduled' | 'done' | 'error' | 'canceled';
export type ScheduledTaskKind = 'once' | 'recurring';

export interface ScheduledTask {
  id: string;
  tenantId: string;
  prompt: string;
  runAt: string; // ISO UTC — the one-shot fire time, or (for recurring) the next occurrence
  timezone: string | null;
  status: ScheduledTaskStatus;
  lastResult: string | null;
  lastError: string | null;
  lastRunAt: string | null;
  kind: ScheduledTaskKind;
  localTime: string | null; // 'HH:MM', recurring only
  daysOfWeek: number[] | null; // 0=Sunday..6=Saturday, recurring only
  nextRunAt: string | null; // ISO UTC, recurring only (mirrors runAt; kept for clarity)
}

interface TaskRow {
  id: string;
  tenant_id: string;
  prompt: string;
  run_at: string;
  timezone: string | null;
  status: ScheduledTaskStatus;
  last_result: string | null;
  last_error: string | null;
  last_run_at: string | null;
  kind: ScheduledTaskKind;
  local_time: string | null;
  days_of_week: number[] | null;
  next_run_at: string | null;
}

function rowToTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    prompt: r.prompt,
    runAt: r.run_at,
    timezone: r.timezone,
    status: r.status,
    lastResult: r.last_result,
    lastError: r.last_error,
    lastRunAt: r.last_run_at,
    kind: r.kind,
    localTime: r.local_time,
    daysOfWeek: r.days_of_week,
    nextRunAt: r.next_run_at,
  };
}

/** Every active (non-terminal) task for a tenant, soonest-firing first. */
export async function listScheduledTasks(tenantId: string): Promise<ScheduledTask[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(COLS)
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .order('run_at', { ascending: true });
  if (error) throw new Error(`Failed to list scheduled tasks: ${error.message}`);
  return (data ?? []).map((r) => rowToTask(r as TaskRow));
}

export async function getScheduledTaskById(id: string): Promise<ScheduledTask | null> {
  const { data, error } = await getSupabase().from(TABLE).select(COLS).eq('id', id).maybeSingle();
  if (error) throw new Error(`Failed to read scheduled task (${id}): ${error.message}`);
  return data ? rowToTask(data as TaskRow) : null;
}

/** A task is "pending" when it is still going to fire (status scheduled AND not in the past). */
export function isPending(task: ScheduledTask | null, now: Date = new Date()): boolean {
  return !!task && task.status === 'scheduled' && new Date(task.runAt).getTime() > now.getTime() - 5 * 60_000;
}

export async function countActiveScheduledTasks(tenantId: string): Promise<number> {
  const { count, error } = await getSupabase()
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled');
  if (error) throw new Error(`Failed to count scheduled tasks: ${error.message}`);
  return count ?? 0;
}

/** Create a fresh one-shot task. Caller must check countActiveScheduledTasks against MAX_ACTIVE_TASKS first. */
export async function createScheduledTask(
  tenantId: string,
  prompt: string,
  runAt: Date,
  timezone: string | null,
): Promise<ScheduledTask> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      tenant_id: tenantId,
      prompt: prompt.trim(),
      run_at: runAt.toISOString(),
      timezone,
      kind: 'once' as const,
      status: 'scheduled' as const,
    })
    .select(COLS)
    .single();
  if (error) throw new Error(`Failed to save scheduled task: ${error.message}`);
  return rowToTask(data as TaskRow);
}

/** Create a fresh recurring task, computing its first occurrence via the shared nextRunFor() engine. */
export async function createRecurringScheduledTask(
  tenantId: string,
  prompt: string,
  recurrence: ResolvedRecurrence,
): Promise<ScheduledTask> {
  const next = nextRunFor(
    { enabled: true, localTime: recurrence.localTime, daysOfWeek: recurrence.daysOfWeek, timezone: recurrence.timezone, lastRunAt: null },
    new Date(),
    recurrence.timezone,
  );
  const runAt = (next.at ?? new Date()).toISOString();
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      tenant_id: tenantId,
      prompt: prompt.trim(),
      run_at: runAt,
      timezone: recurrence.timezone,
      kind: 'recurring' as const,
      local_time: recurrence.localTime,
      days_of_week: recurrence.daysOfWeek,
      next_run_at: runAt,
      status: 'scheduled' as const,
    })
    .select(COLS)
    .single();
  if (error) throw new Error(`Failed to save recurring task: ${error.message}`);
  return rowToTask(data as TaskRow);
}

/** Update an EXISTING task's prompt and/or schedule (agent must already know its id — from a prior
 *  status/list call). Tenant-scoped so a task id can't reach another tenant's row. Re-resolving the
 *  schedule is the caller's job; pass the new runAt/recurrence. */
export async function updateScheduledTask(
  tenantId: string,
  taskId: string,
  patch: { prompt?: string; runAt?: Date; timezone?: string | null; recurrence?: ResolvedRecurrence | null },
): Promise<ScheduledTask | null> {
  const fields: Record<string, unknown> = { status: 'scheduled', last_result: null, last_error: null };
  if (patch.prompt !== undefined) fields.prompt = patch.prompt.trim();
  if (patch.recurrence) {
    const next = nextRunFor(
      { enabled: true, localTime: patch.recurrence.localTime, daysOfWeek: patch.recurrence.daysOfWeek, timezone: patch.recurrence.timezone, lastRunAt: null },
      new Date(),
      patch.recurrence.timezone,
    );
    const runAt = (next.at ?? new Date()).toISOString();
    fields.kind = 'recurring';
    fields.local_time = patch.recurrence.localTime;
    fields.days_of_week = patch.recurrence.daysOfWeek;
    fields.next_run_at = runAt;
    fields.run_at = runAt;
    fields.timezone = patch.recurrence.timezone;
  } else if (patch.runAt) {
    fields.kind = 'once';
    fields.run_at = patch.runAt.toISOString();
    fields.local_time = null;
    fields.days_of_week = null;
    fields.next_run_at = null;
    if (patch.timezone) fields.timezone = patch.timezone;
  } else if (patch.timezone) {
    fields.timezone = patch.timezone;
  }
  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(fields)
    .eq('id', taskId)
    .eq('tenant_id', tenantId)
    .select(COLS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update scheduled task (${taskId}): ${error.message}`);
  return data ? rowToTask(data as TaskRow) : null;
}

/** Cancel one specific task (tenant-scoped so a task id can't cancel another tenant's row). */
export async function cancelScheduledTask(tenantId: string, taskId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .update({ status: 'canceled' })
    .eq('tenant_id', tenantId)
    .eq('id', taskId)
    .eq('status', 'scheduled')
    .select('id');
  if (error) throw new Error(`Failed to cancel scheduled task (${taskId}): ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Finalize a one-shot task's run, OR (kind='recurring') advance it to its next occurrence and keep it
 *  'scheduled' instead of going terminal — the self-rescheduling chain, mirroring run-insight.ts. */
export async function markScheduledTaskStatus(
  taskId: string,
  status: ScheduledTaskStatus,
  detail?: { result?: string; error?: string; ranAt?: Date },
): Promise<void> {
  const fields: Record<string, unknown> = { status };
  if (detail?.result !== undefined) fields.last_result = detail.result.slice(0, 8000);
  if (detail?.error !== undefined) fields.last_error = detail.error.slice(0, 2000);
  if (detail?.ranAt) fields.last_run_at = detail.ranAt.toISOString();
  const { error } = await getSupabase().from(TABLE).update(fields).eq('id', taskId);
  if (error) throw new Error(`Failed to update scheduled task status (${taskId}): ${error.message}`);
}

/** Advance a recurring task to its next occurrence (computed from its own days/time/timezone + the
 *  run that just happened) and keep it 'scheduled'. Returns the new fire time, or null if the task's
 *  recurrence is somehow incomplete (defensive — should not happen for kind='recurring' rows). */
export async function advanceRecurringTask(task: ScheduledTask, ranAt: Date): Promise<Date | null> {
  if (task.kind !== 'recurring' || !task.localTime || !task.daysOfWeek) return null;
  const next = nextRunFor(
    { enabled: true, localTime: task.localTime, daysOfWeek: task.daysOfWeek, timezone: task.timezone, lastRunAt: ranAt.toISOString() },
    ranAt,
    task.timezone,
  );
  if (!next.at) return null;
  const { error } = await getSupabase()
    .from(TABLE)
    .update({
      status: 'scheduled',
      run_at: next.at.toISOString(),
      next_run_at: next.at.toISOString(),
      last_run_at: ranAt.toISOString(),
    })
    .eq('id', task.id);
  if (error) throw new Error(`Failed to advance recurring task (${task.id}): ${error.message}`);
  return next.at;
}

export interface ScheduledTaskForArming {
  task: ScheduledTask;
  tenantTz: string | null;
}

/** Every still-scheduled task + its tenant timezone, for the recovery sweep to (re)arm. */
export async function getScheduledTasksForArming(): Promise<ScheduledTaskForArming[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select(`${COLS}, tenant_master(timezone)`)
    .eq('status', 'scheduled');
  if (error) throw new Error(`Failed to list scheduled tasks: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<
    TaskRow & { tenant_master?: { timezone: string | null } | Array<{ timezone: string | null }> | null }
  >;
  return rows.map((raw) => {
    const tm = Array.isArray(raw.tenant_master) ? raw.tenant_master[0] : raw.tenant_master;
    return { task: rowToTask(raw), tenantTz: tm?.timezone ?? null };
  });
}

// ── Natural-language "when" → absolute UTC instant, or a recurring schedule ───────────────────────

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const DAYS_ALL = [0, 1, 2, 3, 4, 5, 6];
const DAYS_WEEKDAY = [1, 2, 3, 4, 5];
const DAYS_WEEKEND = [0, 6];

export interface ResolvedWhen {
  at: Date | null;
  /** The IANA timezone the time was interpreted in. */
  timezone: string;
  error?: string;
}

export interface ResolvedRecurrence {
  localTime: string; // 'HH:MM'
  daysOfWeek: number[];
  timezone: string;
}

/** Parse a clock time fragment → minutes-of-day, or null. Accepts "9", "9am", "9:30", "14:30", "noon". */
function parseClock(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === 'noon' || t === 'midday') return 12 * 60;
  if (t === 'midnight') return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function civilYmd(y: number, m0: number, d: number, addDays: number): string {
  const civ = new Date(Date.UTC(y, m0, d + addDays));
  return `${civ.getUTCFullYear()}-${String(civ.getUTCMonth() + 1).padStart(2, '0')}-${String(civ.getUTCDate()).padStart(2, '0')}`;
}

function minutesToHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Detect + resolve a RECURRING phrase ("every morning at 8am", "every weekday 9am", "daily at 8am",
 * "every monday and thursday at 10am", "every weekend"). Returns null when `when` isn't recurring
 * phrasing at all, so the caller falls back to the one-shot resolveWhen().
 */
export async function resolveRecurrence(
  whenRaw: string,
  tenantId: string,
  tzOverride?: string | null,
): Promise<ResolvedRecurrence | null> {
  const tenantTz = tzOverride ?? (await resolveTenantTimezone(tenantId));
  const tz = effectiveTimezone({ timezone: tzOverride ?? null }, tenantTz) || DEFAULT_TIMEZONE;
  const lower = (whenRaw ?? '').trim().toLowerCase();
  if (!/\b(every|daily|each\s+day)\b/.test(lower)) return null;

  let daysOfWeek: number[] | null = null;
  if (/\bevery\s+day\b|\bdaily\b|\beach\s+day\b/.test(lower)) daysOfWeek = DAYS_ALL;
  else if (/\bevery\s+(morning|evening|night)\b/.test(lower)) daysOfWeek = DAYS_ALL;
  else if (/\bevery\s+weekday(s)?\b/.test(lower)) daysOfWeek = DAYS_WEEKDAY;
  else if (/\bevery\s+weekend(s)?\b/.test(lower)) daysOfWeek = DAYS_WEEKEND;
  else {
    // Collect every weekday name mentioned ("every monday and thursday", "every mon, wed, fri").
    const found = new Set<number>();
    const re = /\b(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) found.add(WEEKDAYS[m[1]]);
    if (found.size > 0) daysOfWeek = Array.from(found).sort((a, b) => a - b);
  }
  if (!daysOfWeek) return null; // "every" was present but no recognizable day pattern — not recurring

  // Extract a clock time the same way resolveWhen does; default per time-of-day word, else 8am.
  let minutes: number | null = null;
  const atMatch = /\bat\s+([0-9][0-9:]*\s*(?:am|pm)?|noon|midday|midnight)\b/.exec(lower);
  if (atMatch) minutes = parseClock(atMatch[1]);
  if (minutes === null) {
    const bare = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midday|midnight|\d{1,2}:\d{2})\b/.exec(lower);
    if (bare) minutes = parseClock(bare[1]);
  }
  if (minutes === null) minutes = /\b(evening|night)\b/.test(lower) ? 19 * 60 : 8 * 60;

  return { localTime: minutesToHHMM(minutes), daysOfWeek, timezone: tz };
}

/**
 * Resolve a user's natural-language `when` (+ optional explicit ISO) into an absolute future instant
 * interpreted in the tenant's timezone. Supports: ISO 8601; "in N minutes/hours"; "today/tonight/
 * tomorrow [at] TIME"; weekday names ("monday", "next friday") [at TIME]; bare TIME ("4pm" → next time
 * it occurs). A day with no time defaults to 09:00 (evening words → 19:00). Returns {at:null,error} when
 * unparseable, already past, or beyond the horizon. Only for ONE-SHOT phrasing — check
 * resolveRecurrence() first for "every ..."/"daily ..." phrasing.
 */
export async function resolveWhen(
  whenRaw: string,
  tenantId: string,
  now: Date = new Date(),
  tzOverride?: string | null,
): Promise<ResolvedWhen> {
  const tenantTz = tzOverride ?? (await resolveTenantTimezone(tenantId));
  const tz = effectiveTimezone({ timezone: tzOverride ?? null }, tenantTz) || DEFAULT_TIMEZONE;
  const when = (whenRaw ?? '').trim();
  if (!when) return { at: null, timezone: tz, error: 'No time was given.' };

  const finalize = (at: Date): ResolvedWhen => {
    const ms = at.getTime();
    if (ms <= now.getTime() + 30_000) return { at: null, timezone: tz, error: 'That time has already passed — pick a future time.' };
    if (ms > now.getTime() + MAX_HORIZON_DAYS * 86_400_000) {
      return { at: null, timezone: tz, error: `That's too far out — schedule within ${MAX_HORIZON_DAYS} days.` };
    }
    return { at, timezone: tz };
  };

  const lower = when.toLowerCase();

  // 1. Explicit ISO 8601 (with or without offset).
  if (/^\d{4}-\d{2}-\d{2}[t ]\d/.test(lower)) {
    const parsed = new Date(when);
    if (!Number.isNaN(parsed.getTime())) return finalize(parsed);
  }

  // 2. Relative "in N minutes/hours".
  const rel = /^in\s+(\d+)\s*(min|mins|minute|minutes|m|hour|hours|hr|hrs|h|day|days|d)$/.exec(lower);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = /^m(in)?/.test(unit) || unit === 'minute' || unit === 'minutes' ? n * 60_000
      : /^d/.test(unit) ? n * 86_400_000
      : n * 3_600_000;
    return finalize(new Date(now.getTime() + ms));
  }

  const nowLocal = localPartsFor(now, tz);
  const [ny, nm, nd] = nowLocal.ymd.split('-').map(Number);

  // Pull a trailing/standalone clock time out of the phrase ("... at 4pm", "tomorrow 9:30", "4pm").
  let minutes: number | null = null;
  const atMatch = /\bat\s+([0-9][0-9:]*\s*(?:am|pm)?|noon|midday|midnight)\b/.exec(lower);
  if (atMatch) minutes = parseClock(atMatch[1]);
  if (minutes === null) {
    const bare = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midday|midnight|\d{1,2}:\d{2})\b/.exec(lower);
    if (bare) minutes = parseClock(bare[1]);
  }
  const eveningWord = /\b(tonight|evening)\b/.test(lower);
  const defaultMinutes = eveningWord ? 19 * 60 : 9 * 60;

  // 3. Day qualifiers.
  let targetYmd: string | null = null;
  if (/\btoday\b|\btonight\b/.test(lower)) {
    targetYmd = nowLocal.ymd;
  } else if (/\btomorrow\b/.test(lower)) {
    targetYmd = civilYmd(ny, nm - 1, nd, 1);
  } else {
    const wdMatch = /\b(next\s+)?(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|[a-z]+day)\b/.exec(lower);
    if (wdMatch && WEEKDAYS[wdMatch[2]] !== undefined) {
      const wantNext = Boolean(wdMatch[1]);
      const targetDow = WEEKDAYS[wdMatch[2]];
      for (let offset = 0; offset <= 7; offset++) {
        const civ = new Date(Date.UTC(ny, nm - 1, nd + offset));
        if (civ.getUTCDay() !== targetDow) continue;
        const sameDay = offset === 0;
        // "monday" when today is monday → next monday unless an explicit future time today; "next" forces +7.
        if (sameDay && (wantNext || minutes === null || minutes <= nowLocal.minutes)) continue;
        if (offset === 0 && wantNext) continue;
        targetYmd = civilYmd(ny, nm - 1, nd, offset === 0 && wantNext ? 7 : offset);
        break;
      }
      if (!targetYmd) targetYmd = civilYmd(ny, nm - 1, nd, 7);
    }
  }

  // 4. Bare time only (no day) → today if still ahead, else tomorrow.
  if (!targetYmd) {
    if (minutes === null) return { at: null, timezone: tz, error: "I couldn't read a time from that — try \"10am tomorrow\" or \"in 2 hours\"." };
    targetYmd = minutes > nowLocal.minutes ? nowLocal.ymd : civilYmd(ny, nm - 1, nd, 1);
  }

  const at = zonedWallTimeToUtc(targetYmd, minutesToHHMM(minutes ?? defaultMinutes), tz);
  return finalize(at);
}

/** Human label for a fire time in the tenant's timezone, e.g. "tomorrow at 10:00 AM (Asia/Jakarta)". */
export function describeRunAt(at: Date, tz: string, now: Date = new Date()): string {
  const atL = localPartsFor(at, tz);
  const nowL = localPartsFor(now, tz);
  const [ny, nm, nd] = nowL.ymd.split('-').map(Number);
  const tomYmd = civilYmd(ny, nm - 1, nd, 1);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = atL.ymd === nowL.ymd ? 'today' : atL.ymd === tomYmd ? 'tomorrow' : `${DAYS[atL.weekday]} (${atL.ymd})`;
  const h = Math.floor(atL.minutes / 60);
  const m = atL.minutes % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day} at ${h12}:${String(m).padStart(2, '0')} ${ap} (${tz})`;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human label for a recurring schedule, e.g. "every day at 8:00 AM (Asia/Jakarta)" or "every Mon, Thu at 9:00 AM". */
export function describeRecurrence(rec: { localTime: string; daysOfWeek: number[] }, tz: string): string {
  const [h, m] = rec.localTime.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const time = `${h12}:${String(m).padStart(2, '0')} ${ap}`;
  const sorted = [...rec.daysOfWeek].sort((a, b) => a - b);
  const days =
    sorted.length === 7 ? 'day'
    : sorted.join(',') === DAYS_WEEKDAY.join(',') ? 'weekday'
    : sorted.join(',') === DAYS_WEEKEND.join(',') ? 'weekend'
    : sorted.map((d) => DAY_ABBR[d]).join(', ');
  return `every ${days} at ${time} (${tz})`;
}
