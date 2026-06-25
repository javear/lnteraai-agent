// Per-tenant one-shot "future action" for the Active Agent: store the natural-language instruction +
// the absolute fire time, read/combine/cancel it, and resolve when a user's phrasing ("10am tomorrow",
// "in 2 hours", "Friday at 4pm") lands as an absolute UTC instant in the tenant's timezone.
//
// Free tier = exactly ONE active task per tenant (the unique (tenant_id) row). A new request while one
// is pending COMBINES (appends the instruction, keeps or updates the single fire time); once a task has
// run, the same row is reused for the next request. Scheduling itself is event-driven — see
// inngest/arm-scheduled-task.ts. The DB `status` is the authority that prevents a double-run.
import { getSupabase } from './supabase';
import {
  DEFAULT_TIMEZONE,
  effectiveTimezone,
  localPartsFor,
  resolveTenantTimezone,
  zonedWallTimeToUtc,
} from './insight-schedule-prefs';

const TABLE = 'tenant_scheduled_tasks';
const COLS = 'id, tenant_id, prompt, run_at, timezone, status, last_result, last_error, last_run_at';

/** Furthest out a one-shot task may be scheduled (keeps the delayed Inngest event within a sane bound). */
export const MAX_HORIZON_DAYS = 60;

export type ScheduledTaskStatus = 'scheduled' | 'done' | 'error' | 'canceled';

export interface ScheduledTask {
  id: string;
  tenantId: string;
  prompt: string;
  runAt: string; // ISO UTC
  timezone: string | null;
  status: ScheduledTaskStatus;
  lastResult: string | null;
  lastError: string | null;
  lastRunAt: string | null;
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
  };
}

export async function getScheduledTask(tenantId: string): Promise<ScheduledTask | null> {
  const { data, error } = await getSupabase().from(TABLE).select(COLS).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`Failed to read scheduled task: ${error.message}`);
  return data ? rowToTask(data as TaskRow) : null;
}

/** A task is "pending" when it is still going to fire (status scheduled AND not in the past). */
export function isPending(task: ScheduledTask | null, now: Date = new Date()): boolean {
  return !!task && task.status === 'scheduled' && new Date(task.runAt).getTime() > now.getTime() - 5 * 60_000;
}

/** Create or replace the single row for the tenant (used for a fresh task / explicit replace). */
export async function setScheduledTask(
  tenantId: string,
  prompt: string,
  runAt: Date,
  timezone: string | null,
): Promise<ScheduledTask> {
  const supabase = getSupabase();
  const fields = {
    tenant_id: tenantId,
    prompt: prompt.trim(),
    run_at: runAt.toISOString(),
    timezone,
    status: 'scheduled' as const,
    last_result: null,
    last_error: null,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(fields, { onConflict: 'tenant_id' })
    .select(COLS)
    .single();
  if (error) throw new Error(`Failed to save scheduled task: ${error.message}`);
  return rowToTask(data as TaskRow);
}

/** Combine a new instruction into the existing pending task (keeps fire time unless `runAt` is given). */
export async function combineScheduledTask(
  existing: ScheduledTask,
  addPrompt: string,
  runAt: Date | null,
  timezone: string | null,
): Promise<ScheduledTask> {
  const mergedPrompt = `${existing.prompt.trim()}\n- ${addPrompt.trim()}`;
  const fields: Record<string, unknown> = { prompt: mergedPrompt, status: 'scheduled', last_result: null, last_error: null };
  if (runAt) fields.run_at = runAt.toISOString();
  if (timezone) fields.timezone = timezone;
  const { data, error } = await getSupabase().from(TABLE).update(fields).eq('id', existing.id).select(COLS).single();
  if (error) throw new Error(`Failed to combine scheduled task: ${error.message}`);
  return rowToTask(data as TaskRow);
}

export async function cancelScheduledTask(tenantId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .update({ status: 'canceled' })
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .select('id');
  if (error) throw new Error(`Failed to cancel scheduled task: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

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
  if (error) throw new Error(`Failed to update scheduled task status: ${error.message}`);
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

// ── Natural-language "when" → absolute UTC instant ────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

export interface ResolvedWhen {
  at: Date | null;
  /** The IANA timezone the time was interpreted in. */
  timezone: string;
  error?: string;
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

/**
 * Resolve a user's natural-language `when` (+ optional explicit ISO) into an absolute future instant
 * interpreted in the tenant's timezone. Supports: ISO 8601; "in N minutes/hours"; "today/tonight/
 * tomorrow [at] TIME"; weekday names ("monday", "next friday") [at TIME]; bare TIME ("4pm" → next time
 * it occurs). A day with no time defaults to 09:00 (evening words → 19:00). Returns {at:null,error} when
 * unparseable, already past, or beyond the horizon.
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

function minutesToHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
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
