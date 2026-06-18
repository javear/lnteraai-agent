// Agent-callable "subscribe to / configure automatic business insights". Lets the seller set up (or
// change) their scheduled analysis by chatting: enable/disable, pick days + time + timezone, and
// choose which insights. Lenient parsing (the LLM extracts natural values like "weekdays at 9am").
// Writes the single per-tenant schedule via setInsightSchedule (mirrors the frontend PUT).
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import {
  describeNextRun,
  getInsightSchedule,
  normalizeLocalTime,
  setInsightSchedule,
  type InsightSchedulePatch,
} from '../../integrations/shared/insight-schedule-prefs';
import { listProviders } from '../../insights/providers';
import { armNextRun } from '../../inngest/arm-insight';

const inputSchema = z.record(z.string(), z.unknown());

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDays(input: unknown): number[] | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') {
    const s = input.toLowerCase().trim();
    if (s === 'daily' || s === 'everyday' || s === 'every day') return [0, 1, 2, 3, 4, 5, 6];
    if (s === 'weekdays') return [1, 2, 3, 4, 5];
    if (s === 'weekends') return [0, 6];
    return parseDays(s.split(/[,\s]+/).filter(Boolean));
  }
  if (Array.isArray(input)) {
    const out = new Set<number>();
    for (const d of input) {
      if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6) out.add(d);
      else if (typeof d === 'string') {
        const t = d.toLowerCase().trim();
        if (DAY_NAMES[t] != null) out.add(DAY_NAMES[t]);
        else if (/^[0-6]$/.test(t)) out.add(Number(t));
      }
    }
    return out.size ? [...out].sort((a, b) => a - b) : undefined;
  }
  return undefined;
}

function parseTime(input: unknown): string | undefined {
  if (input == null) return undefined;
  const s = String(input).trim().toLowerCase();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return normalizeLocalTime(`${h}:${min}`);
}

function parseInsightKeys(input: unknown): string[] | null | undefined {
  if (input == null) return undefined;
  const valid = new Set(listProviders().map((p) => p.key));
  const asArray = Array.isArray(input) ? input : [input];
  const cleaned: string[] = [];
  for (const v of asArray) {
    const t = String(v).toLowerCase().trim();
    if (t === 'all' || t === 'everything' || t === 'every') return null; // null = all
    if (valid.has(t)) cleaned.push(t);
  }
  return cleaned.length ? [...new Set(cleaned)] : undefined;
}

function summarize(s: {
  enabled: boolean;
  localTime: string;
  daysOfWeek: number[];
  timezone: string | null;
  subscribedKeys: string[] | null;
}): string {
  if (!s.enabled) return 'Automatic business insights are turned OFF.';
  const days = s.daysOfWeek.length === 7 ? 'every day' : s.daysOfWeek.map((d) => DAY_LABEL[d]).join(', ');
  const which = s.subscribedKeys ? `${s.subscribedKeys.length} selected insight(s)` : 'all insights';
  const tz = s.timezone ? ` (${s.timezone})` : '';
  return `Automatic insights ON — ${days} at ${s.localTime}${tz}, covering ${which}.`;
}

export const configureInsightsTool = createTool({
  id: 'configure-business-insights',
  strict: false,
  description:
    'Set up or change the seller\'s scheduled automatic business analysis (insights). Enable/disable, pick days + time of day + timezone, and choose which insights to receive. Use when the user asks to schedule, subscribe to, turn on/off, or change their automatic business analysis / daily report / insights.',
  requestContextSchema: z.object({
    [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  }),
  inputSchema,
  inputExamples: [
    { input: { enabled: true, days: 'weekdays', time: '9am' } },
    { input: { time: '18:00', days: ['mon', 'thu'], timezone: 'Asia/Jakarta' } },
    { input: { insights: ['orders-unprocessed', 'cancellation-rate'] } },
    { input: { enabled: false } },
  ],
  outputSchema: z.object({
    enabled: z.boolean(),
    localTime: z.string(),
    daysOfWeek: z.array(z.number()),
    timezone: z.string().nullable(),
    subscribedKeys: z.array(z.string()).nullable(),
    availableInsights: z.array(z.object({ key: z.string(), label: z.string() })),
    summaryText: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

    const patch: InsightSchedulePatch = {};
    if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
    const time = parseTime(raw.time ?? raw.localTime ?? raw.at);
    if (time) patch.localTime = time;
    const days = parseDays(raw.days ?? raw.daysOfWeek ?? raw.weekdays);
    if (days) patch.daysOfWeek = days;
    if (typeof raw.timezone === 'string' && raw.timezone.trim()) patch.timezone = raw.timezone.trim();
    const keys = parseInsightKeys(raw.insights ?? raw.subscribedKeys ?? raw.types);
    if (keys !== undefined) patch.subscribedKeys = keys;
    // Enabling implicitly when the user gives a time/days but doesn't say enabled.
    if (patch.enabled === undefined && (patch.localTime || patch.daysOfWeek)) patch.enabled = true;

    const saved = await (Object.keys(patch).length
      ? setInsightSchedule(tenantId, patch)
      : getInsightSchedule(tenantId).then((s) => s ?? setInsightSchedule(tenantId, {})));

    // (Re)schedule the next run immediately so a chat-driven change takes effect without waiting for
    // the recovery sweep.
    await armNextRun(tenantId, saved);

    // Tell the user WHEN the next analysis lands — and call out when it's deferred to a later day
    // (e.g. today's run already happened), so a same-day time change isn't silently skipped.
    const desc = describeNextRun(saved, new Date());
    let nextLine = '';
    if (saved.enabled && desc.label) {
      nextLine = desc.firesToday
        ? ` Next analysis runs ${desc.label}.`
        : ` It won't run again today — the next analysis runs ${desc.label}.`;
    }

    return {
      enabled: saved.enabled,
      localTime: saved.localTime,
      daysOfWeek: saved.daysOfWeek,
      timezone: saved.timezone,
      subscribedKeys: saved.subscribedKeys,
      availableInsights: listProviders().map((p) => ({ key: p.key, label: p.label })),
      summaryText: summarize(saved) + nextLine,
    };
  },
});
