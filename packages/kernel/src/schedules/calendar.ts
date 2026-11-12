import { type ScanStep, scanStep, ticksIn } from "./schedule-math.js";
import type {
  ScheduledTask,
  ScheduleMode,
  SchedulePauseReason,
  ScheduleStatus,
  ScheduleTrigger,
  TaskRun,
  TaskRunSkipReason,
  TaskRunStatus,
} from "./types.js";

/**
 * The scheduled task calendar (spec 2026-11-12-scheduled-tasks-calendar-design.md §5): recorded
 * runs and planned occurrences between two instants, dense task-days collapsed, cut at a whole
 * day when a limit is reached. The assembly here is pure; `ScheduledTasksService.calendar` reads
 * the rows and decides who sees what.
 */

const DAY_MS = 86_400_000;

/** Planned occurrences reach this far ahead of now (spec §5.2, "about six weeks"). */
export const CALENDAR_HORIZON_DAYS = 42;
/** The longest range one request may ask for: a 6-week month grid plus a DST hour (§5.1). */
export const CALENDAR_RANGE_DAYS = 43;
/** The longest range with `taskId` (the panel's one-day list, §5.4). */
export const CALENDAR_TASK_RANGE_DAYS = 2;
/** A task-day with more items than this is collapsed into one summary (§5.4). */
export const CALENDAR_COLLAPSE_OVER = 6;
/** Tick evaluations per request, across all tasks (§5.5). */
export const CALENDAR_TICK_BUDGET = 20_000;
/** Entries (`items` + `collapsed`) per request (§5.5). */
export const CALENDAR_ITEM_CAP = 3_000;

/** The limits of one assembly; tests lower them. */
export interface CalendarLimits {
  horizonDays: number;
  collapseOver: number;
  tickBudget: number;
  itemCap: number;
}

export const CALENDAR_LIMITS: CalendarLimits = {
  horizonDays: CALENDAR_HORIZON_DAYS,
  collapseOver: CALENDAR_COLLAPSE_OVER,
  tickBudget: CALENDAR_TICK_BUDGET,
  itemCap: CALENDAR_ITEM_CAP,
};

/** A task an entry of the answer names. */
export interface CalendarTask {
  id: string;
  name: string;
  agentId: string;
  accountId: string;
  status: ScheduleStatus;
  pauseReason: SchedulePauseReason | null;
  trigger: ScheduleTrigger;
  mode: ScheduleMode;
  jitterSeconds: number;
  nextRunAt: string | null;
}

export type CalendarItem =
  | {
      kind: "run";
      taskId: string;
      /** The task run's id. */
      id: string;
      scheduledFor: string;
      firedAt: string | null;
      status: TaskRunStatus;
      skipReason: TaskRunSkipReason | null;
      trial: boolean;
      manual: boolean;
      /** Null for another member's run (admin `all`, spec §15 Q3), as `error` and `missingGrants`. */
      conversationId: string | null;
      error: string | null;
      missingGrants: number | null;
    }
  | {
      kind: "occurrence";
      taskId: string;
      /** The tick, before jitter. */
      scheduledFor: string;
      /** When it fires: the tick plus the task's jitter. */
      at: string;
    };

/** A task's items of one local day, summarized (§5.4). */
export interface CalendarCollapsed {
  taskId: string;
  /** YYYY-MM-DD in the request's `timeZone`. */
  day: string;
  count: number;
  upcoming: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  /** The earliest and latest `scheduledFor` of the day's items. */
  first: string;
  last: string;
}

export interface CalendarAnswer {
  tasks: CalendarTask[];
  items: CalendarItem[];
  collapsed: CalendarCollapsed[];
  /** Nothing is returned after it: 42 days ahead, or the cut. */
  horizon: string;
  /** A limit cut the range at a whole local day. */
  truncated: boolean;
}

export interface CalendarInput {
  /** The live tasks the viewer may see in this request. */
  tasks: readonly ScheduledTask[];
  /**
   * Their runs with `scheduledFor` in `[from, to)`, trial included, ordered by `scheduledFor`: at
   * most one more than the tick budget (rows past it are not read; the range is cut there).
   */
  runs: readonly TaskRun[];
  /** The viewer: another creator's runs lose `conversationId`, `error` and `missingGrants`. */
  viewerAccountId: string;
  from: Date;
  to: Date;
  /** The viewer's zone: local days for the collapse and the cut. */
  timeZone: string;
  now: Date;
  /** False when the org turned scheduled tasks off: nothing would fire, so nothing is planned. */
  plan: boolean;
  /** The org's catch-up window, as the scanner reads it. */
  catchUpWindowMinutes: number;
  /** False for a `taskId` read: every item, never collapsed. */
  collapse: boolean;
}

type Entry =
  | { kind: "item"; at: number; taskId: string; item: CalendarItem }
  | { kind: "collapsed"; at: number; taskId: string; collapsed: CalendarCollapsed };

/** The calendar answer from the rows (spec §5.2–§5.5). */
export function assembleCalendar(
  input: CalendarInput,
  limits: CalendarLimits = CALENDAR_LIMITS,
): CalendarAnswer {
  const { timeZone, now } = input;
  const horizonAt = now.getTime() + limits.horizonDays * DAY_MS;
  // `cut`: the exclusive end of what is returned; a limit moves it back to a local day start
  let cut = input.to.getTime();
  let truncated = false;
  // the run read is bounded too (the service reads one row more than the tick budget, by tick):
  // past the budget, the range ends at the start of the local day of the first row over it
  const overRun = input.runs[limits.tickBudget];
  if (overRun !== undefined) {
    cut = startOfLocalDay(overRun.scheduledFor.getTime(), timeZone);
    truncated = true;
  }

  const planned = input.plan
    ? planOccurrences(input, horizonAt, limits.tickBudget, cut)
    : { ticks: new Map<string, number[]>(), cut };
  if (planned.cut < cut) {
    cut = planned.cut;
    truncated = true;
  }

  // a tick the scan recorded is shown as its run, never twice
  const recorded = new Set(
    input.runs.filter((r) => !r.trial).map((r) => `${r.taskId}|${r.scheduledFor.getTime()}`),
  );
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const raw: { at: number; taskId: string; item: CalendarItem }[] = [];
  for (const r of input.runs) {
    const own = byId.get(r.taskId)?.accountId === input.viewerAccountId;
    raw.push({ at: r.scheduledFor.getTime(), taskId: r.taskId, item: runItem(r, own) });
  }
  for (const [taskId, ticks] of planned.ticks) {
    const jitterMs = (byId.get(taskId)?.jitterSeconds ?? 0) * 1000;
    for (const tick of ticks) {
      if (recorded.has(`${taskId}|${tick}`)) continue;
      raw.push({
        at: tick,
        taskId,
        item: {
          kind: "occurrence",
          taskId,
          scheduledFor: new Date(tick).toISOString(),
          at: new Date(tick + jitterMs).toISOString(),
        },
      });
    }
  }

  // group by local day, then by task: a task-day over the threshold becomes one summary
  const days = new Map<string, Map<string, typeof raw>>();
  for (const e of raw) {
    if (e.at >= cut) continue;
    const day = dayKey(e.at, timeZone);
    let tasks = days.get(day);
    if (!tasks) {
      tasks = new Map();
      days.set(day, tasks);
    }
    const list = tasks.get(e.taskId);
    if (list) list.push(e);
    else tasks.set(e.taskId, [e]);
  }

  // walk the days in order; a day is added whole or not at all
  const entries: Entry[] = [];
  for (const day of [...days.keys()].sort()) {
    const dayEntries: Entry[] = [];
    for (const [taskId, list] of days.get(day) ?? []) {
      if (input.collapse && list.length > limits.collapseOver) {
        dayEntries.push({
          kind: "collapsed",
          at: firstAt(list),
          taskId,
          collapsed: summarize(taskId, day, list),
        });
      } else {
        for (const e of list) dayEntries.push({ kind: "item", ...e });
      }
    }
    if (entries.length + dayEntries.length > limits.itemCap) {
      const start = startOfLocalDay(dayEntries[0]?.at ?? cut, timeZone);
      if (start < cut) {
        cut = start;
        truncated = true;
      }
      break;
    }
    entries.push(...dayEntries);
  }

  const kept = entries.filter((e) => e.at < cut);
  kept.sort((a, b) => a.at - b.at || cmp(a.taskId, b.taskId) || cmp(entryKey(a), entryKey(b)));
  const items: CalendarItem[] = [];
  const collapsed: CalendarCollapsed[] = [];
  const named = new Set<string>();
  for (const e of kept) {
    named.add(e.taskId);
    if (e.kind === "item") items.push(e.item);
    else collapsed.push(e.collapsed);
  }
  return {
    tasks: input.tasks.filter((t) => named.has(t.id)).map(calendarTask),
    items,
    collapsed,
    horizon: new Date(truncated ? Math.min(cut, horizonAt) : horizonAt).toISOString(),
    truncated,
  };
}

/** One active task's ticks, pulled one at a time (`after`: the last tick pulled). */
interface TickStream {
  task: ScheduledTask;
  /** The last tick to plan (inclusive): `min(to, horizon, expires_at)`. */
  until: number;
  after: number;
}

/** The stream's next tick, or null when it has no more (or its trigger cannot be evaluated). */
function pull(s: TickStream): number | null {
  if (s.after >= s.until) return null;
  try {
    const tick = ticksIn(s.task.trigger, new Date(s.after), new Date(s.until), 1).ticks[0];
    s.after = tick === undefined ? Number.POSITIVE_INFINITY : tick.getTime();
    return tick === undefined ? null : s.after;
  } catch {
    // a trigger the math cannot evaluate: the scanner pauses the task; nothing to plan
    s.after = Number.POSITIVE_INFINITY;
    return null;
  }
}

/**
 * Each active task's planned ticks in `[from, min(to, horizon, expires_at)]` (spec §5.2), from the
 * scanner's own math: a task already due (`next_run_at <= now`, not scanned yet) keeps only the
 * tick the scan will fire (the latest due one inside the catch-up window; the older ones become
 * one `missed` run), then the ticks after it as the scan continues; a task not due starts at its
 * due tick, `next_run_at - jitter`.
 *
 * The tasks' ticks are taken in time order across all tasks (a merge), each one tick evaluation;
 * the first tick past the budget cuts the range at the start of its local day, and the ticks
 * already taken on that day are dropped, so the days before the cut are whole (spec §5.5).
 */
function planOccurrences(
  input: CalendarInput,
  horizonAt: number,
  budget: number,
  end: number,
): { ticks: Map<string, number[]>; cut: number } {
  const fromMs = input.from.getTime();
  const ticks = new Map<string, number[]>();
  const heap = new TickHeap();
  for (const task of input.tasks) {
    if (task.status !== "active" || task.nextRunAt === null) continue;
    const jitterMs = task.jitterSeconds * 1000;
    const until = Math.min(
      end - 1,
      horizonAt,
      task.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    if (until < fromMs) continue;
    let after = task.nextRunAt.getTime() - jitterMs - 1;
    let first: number | null = null;
    if (task.nextRunAt.getTime() <= input.now.getTime()) {
      let step: ScanStep;
      try {
        step = scanStep(
          {
            trigger: task.trigger,
            nextRunAt: task.nextRunAt,
            jitterSeconds: task.jitterSeconds,
            expiresAt: task.expiresAt,
          },
          input.now,
          input.catchUpWindowMinutes,
        );
      } catch {
        continue;
      }
      const fire = step.fire?.getTime();
      if (fire !== undefined && fire >= fromMs && fire <= until) first = fire;
      after =
        step.nextRunAt === null
          ? Number.POSITIVE_INFINITY
          : step.nextRunAt.getTime() - jitterMs - 1;
    }
    const stream: TickStream = { task, until, after: Math.max(after, fromMs - 1) };
    const head = first ?? pull(stream);
    if (head === null) continue;
    ticks.set(task.id, []);
    heap.push({ at: head, stream });
  }
  let cut = end;
  let used = 0;
  for (let top = heap.pop(); top !== undefined; top = heap.pop()) {
    if (used >= budget) {
      cut = startOfLocalDay(top.at, input.timeZone);
      break;
    }
    ticks.get(top.stream.task.id)?.push(top.at);
    used++;
    const next = pull(top.stream);
    if (next !== null) heap.push({ at: next, stream: top.stream });
  }
  if (cut < end) {
    for (const [id, list] of ticks)
      ticks.set(
        id,
        list.filter((t) => t < cut),
      );
  }
  return { ticks, cut };
}

/** A binary min-heap of stream heads by tick, then task id (a stable order). */
class TickHeap {
  private readonly a: { at: number; stream: TickStream }[] = [];

  private less(i: number, j: number): boolean {
    const x = this.a[i] as { at: number; stream: TickStream };
    const y = this.a[j] as { at: number; stream: TickStream };
    return x.at < y.at || (x.at === y.at && x.stream.task.id < y.stream.task.id);
  }

  private swap(i: number, j: number): void {
    const t = this.a[i] as { at: number; stream: TickStream };
    this.a[i] = this.a[j] as { at: number; stream: TickStream };
    this.a[j] = t;
  }

  push(e: { at: number; stream: TickStream }): void {
    this.a.push(e);
    for (let i = this.a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): { at: number; stream: TickStream } | undefined {
    const top = this.a[0];
    const last = this.a.pop();
    if (top === undefined || last === undefined || this.a.length === 0) return top;
    this.a[0] = last;
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.a.length && this.less(l, m)) m = l;
      if (r < this.a.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

function runItem(r: TaskRun, own: boolean): CalendarItem {
  return {
    kind: "run",
    taskId: r.taskId,
    id: r.id,
    scheduledFor: r.scheduledFor.toISOString(),
    firedAt: r.firedAt?.toISOString() ?? null,
    status: r.status,
    skipReason: r.skipReason,
    trial: r.trial,
    manual: r.manual,
    conversationId: own ? r.conversationId : null,
    error: own ? r.error : null,
    missingGrants: own ? r.missingGrants.length : null,
  };
}

function summarize(
  taskId: string,
  day: string,
  list: readonly { at: number; item: CalendarItem }[],
): CalendarCollapsed {
  const c: CalendarCollapsed = {
    taskId,
    day,
    count: list.length,
    upcoming: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    first: new Date(firstAt(list)).toISOString(),
    last: new Date(Math.max(...list.map((e) => e.at))).toISOString(),
  };
  for (const { item } of list) {
    if (item.kind === "occurrence") c.upcoming++;
    else if (item.status === "pending" || item.status === "running") c.running++;
    else c[item.status]++;
  }
  return c;
}

function calendarTask(t: ScheduledTask): CalendarTask {
  return {
    id: t.id,
    name: t.name,
    agentId: t.agentId,
    accountId: t.accountId,
    status: t.status,
    pauseReason: t.pauseReason,
    trigger: t.trigger,
    mode: t.mode,
    jitterSeconds: t.jitterSeconds,
    nextRunAt: t.nextRunAt?.toISOString() ?? null,
  };
}

const firstAt = (list: readonly { at: number }[]) => Math.min(...list.map((e) => e.at));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const entryKey = (e: Entry) =>
  e.kind === "collapsed" ? "~" : e.item.kind === "run" ? `r${e.item.id}` : "o";

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD of the instant (epoch ms) in `timeZone`. */
export function dayKey(ms: number, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The first instant (epoch ms) of the local day of `ms` in `timeZone`: midnight, or the end of a
 * DST gap that swallows it. A day is at most 25 hours long, so 27 hours back is an earlier day.
 */
export function startOfLocalDay(ms: number, timeZone: string): number {
  const day = dayKey(ms, timeZone);
  let lo = ms - 27 * 3_600_000;
  let hi = ms;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, timeZone) < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
