import { CronTime } from "cron";
import { isTimeZone } from "../time-zone.js";
import type { ScheduleTrigger } from "./types.js";

/** Spec §5: how many upcoming fire times the minimum-interval check looks at. */
const GAP_SAMPLE = 50;
const JITTER_CAP_SECONDS = 300;
const LOCAL_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type TriggerError =
  | "schedule.invalid_cron"
  | "schedule.invalid_time_zone"
  | "schedule.invalid_once_time"
  | "schedule.once_in_past";

function cronTime(expr: string, timeZone: string): CronTime | null {
  if (expr.trim().split(/\s+/).length !== 5) return null;
  try {
    return new CronTime(expr.trim(), timeZone);
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone (pure, so a module-level cache is safe). */
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of `utc` (epoch ms) in `timeZone`, read as if it were UTC (epoch ms). */
function wallOf(utc: number, timeZone: string): number {
  const p: Record<string, string | undefined> = Object.fromEntries(
    zoneFormat(timeZone)
      .formatToParts(new Date(utc))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** The zone's UTC offset (ms) at `utc`. */
function offsetAt(utc: number, timeZone: string): number {
  return wallOf(Math.floor(utc / 1000) * 1000, timeZone) - Math.floor(utc / 1000) * 1000;
}

/**
 * The UTC instant of a local date-time (no offset) in `timeZone`; null when malformed or out of
 * range. A repeated local time takes its first occurrence; a time inside a DST gap resolves to the
 * first valid instant after the gap.
 */
function onceInstant(at: string, timeZone: string): Date | null {
  const m = LOCAL_AT.exec(at);
  if (!m) return null;
  const n = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0] = n;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    sec > 59
  ) {
    return null;
  }
  const before = offsetAt(wall - 86400000, timeZone);
  const after = offsetAt(wall + 86400000, timeZone);
  const valid = [before, after]
    .map((o) => wall - o)
    .filter((u, i) => offsetAt(u, timeZone) === [before, after][i])
    .sort((x, z) => x - z);
  if (valid[0] !== undefined) return new Date(valid[0]);
  // In a gap: find the transition second between the two candidates.
  let lo = Math.floor((wall - after) / 1000);
  let hi = Math.floor((wall - before) / 1000);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid * 1000, timeZone) === before) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo * 1000);
}

export function validateTrigger(
  t: ScheduleTrigger,
  now: Date,
): { ok: true } | { ok: false; code: TriggerError } {
  if (!isTimeZone(t.timeZone)) return { ok: false, code: "schedule.invalid_time_zone" };
  if (t.kind === "cron") {
    return cronTime(t.expr, t.timeZone)
      ? { ok: true }
      : { ok: false, code: "schedule.invalid_cron" };
  }
  const at = onceInstant(t.at, t.timeZone);
  if (!at) return { ok: false, code: "schedule.invalid_once_time" };
  if (at.getTime() <= now.getTime()) return { ok: false, code: "schedule.once_in_past" };
  return { ok: true };
}

/** The first tick strictly after `after` (before jitter); null for a past once task. */
export function nextTick(t: ScheduleTrigger, after: Date): Date | null {
  return ticker(t)(after);
}

/** The first tick strictly after `after` (before jitter) of one trigger; null when none. */
export type Ticker = (after: Date) => Date | null;

/**
 * The scanner's ticker for one trigger ({@link nextTick} without rebuilding its `CronTime`s per
 * call), for callers that walk the same trigger many times ({@link ticksIn}).
 */
export function tickerOf(t: ScheduleTrigger): Ticker {
  return ticker(t);
}

/** How far back a DST transition can move a tick: longer than any gap (spec §5). */
const TRANSITION_LOOKBACK_MS = 6 * 3600_000;

/**
 * {@link nextTick} for one trigger, with its `CronTime`s built once: callers that walk many ticks
 * (the gap sample, the catch-up enumeration) reuse one ticker instead of rebuilding per tick.
 */
function ticker(t: ScheduleTrigger): Ticker {
  if (t.kind === "once") {
    const at = onceInstant(t.at, t.timeZone);
    return (after) => (at && at.getTime() > after.getTime() ? at : null);
  }
  const time = cronTime(t.expr, t.timeZone);
  const wallTime = cronTime(t.expr, "UTC");
  if (!time || !wallTime) return () => null;
  return (after) => {
    let cursor = after;
    for (let i = 0; i < 10; i++) {
      const tick = new Date(time.getNextDateFrom(cursor, t.timeZone).toMillis());
      const ms = tick.getTime();
      // CronTime moves a tick that falls in a DST gap to the next valid instant; the spec says a
      // skipped local time does not fire, so keep only ticks whose wall clock the expression
      // names. A moved tick lies just after a transition, so only then is the check needed.
      if (offsetAt(ms, t.timeZone) === offsetAt(ms - TRANSITION_LOOKBACK_MS, t.timeZone)) {
        return tick;
      }
      const wall = localWallClock(tick, t.timeZone);
      if (wallTime.getNextDateFrom(new Date(wall - 1000), "UTC").toMillis() === wall) return tick;
      cursor = tick;
    }
    return null;
  };
}

/**
 * The ticks in `(after, until]` (before jitter), at most `max`, from the same ticker
 * {@link nextTick} and {@link dueTicks} use, so a list of planned runs equals what the scanner
 * fires (calendar spec §5.2). `exhausted`: `max` ticks were taken before a tick past `until` was
 * seen, so more may follow. A `once` trigger yields its one tick when it lies in the window.
 * Costs one tick evaluation per tick returned, plus one when the walk reaches `until`. A caller
 * that walks one trigger in many windows passes a {@link tickerOf} it built once.
 */
export function ticksIn(
  t: ScheduleTrigger | Ticker,
  after: Date,
  until: Date,
  max: number,
): { ticks: Date[]; exhausted: boolean } {
  const ticks: Date[] = [];
  if (after.getTime() >= until.getTime()) return { ticks, exhausted: false };
  const next = typeof t === "function" ? t : ticker(t);
  let cursor = after;
  while (ticks.length < max) {
    const tick = next(cursor);
    if (!tick || tick.getTime() > until.getTime()) return { ticks, exhausted: false };
    ticks.push(tick);
    cursor = tick;
  }
  return { ticks, exhausted: true };
}

/** What one scan does to a due task (spec §6 step 1), as {@link scanStep} decides it. */
export interface ScanStep {
  /** The first missed tick, recorded as one skipped run (`missed`); null when none. */
  missed: Date | null;
  /** The tick whose run is recorded and fired; null when none. */
  fire: Date | null;
  /** The task's new `next_run_at` (jitter included); null when it ends. */
  nextRunAt: Date | null;
  /** Why the task ends: no tick left (`done`) or the next one lies past `expires_at`. */
  end: "done" | "expired" | null;
}

/**
 * One scan of a due task (`next_run_at <= now`) as of `now`, the schedule math alone: the ticks
 * are before jitter, so the due tick is `nextRunAt - jitter` and a tick is due once
 * `tick + jitter <= now`. The scanner applies the result; the calendar's parity test drives it.
 * Throws when the trigger cannot be evaluated.
 */
export function scanStep(
  task: {
    trigger: ScheduleTrigger;
    nextRunAt: Date;
    jitterSeconds: number;
    expiresAt: Date | null;
  },
  now: Date,
  catchUpWindowMinutes: number,
): ScanStep {
  const jitterMs = task.jitterSeconds * 1000;
  const dueTick = new Date(task.nextRunAt.getTime() - jitterMs);
  const until = new Date(now.getTime() - jitterMs);
  const ticks = dueTicks(
    task.trigger,
    new Date(dueTick.getTime() - 1),
    until,
    catchUpWindowMinutes,
  );
  const next = nextTick(task.trigger, until);
  const expires = task.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const fire = ticks.fire !== null && ticks.fire.getTime() <= expires ? ticks.fire : null;
  const first = ticks.firstMissed;
  const missed = first !== null && first.getTime() <= expires ? first : null;
  if (next === null) return { missed, fire, nextRunAt: null, end: "done" };
  if (next.getTime() > expires) return { missed, fire, nextRunAt: null, end: "expired" };
  return { missed, fire, nextRunAt: new Date(next.getTime() + jitterMs), end: null };
}

/** The wall clock of `at` in `timeZone`, read as if it were UTC (epoch ms, seconds dropped). */
function localWallClock(at: Date, timeZone: string): number {
  return Math.floor(wallOf(at.getTime(), timeZone) / 60000) * 60000;
}

/** The smallest gap, in minutes, among the next 50 fire times after `from`; null for once. */
export function minGapMinutes(t: ScheduleTrigger, from: Date): number | null {
  if (t.kind === "once") return null;
  const next = ticker(t);
  let prev = next(from);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; prev && i < GAP_SAMPLE; i++) {
    const tick = next(prev);
    if (!tick) break;
    min = Math.min(min, (tick.getTime() - prev.getTime()) / 60000);
    prev = tick;
  }
  return Number.isFinite(min) ? min : null;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `s`. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A fixed per-task offset: `fnv1a32(id) mod min(floor(10 % of the interval), 300 s)`; once is 0. */
export function jitterSeconds(taskId: string, t: ScheduleTrigger, from: Date): number {
  return jitterForGap(taskId, minGapMinutes(t, from));
}

/**
 * {@link jitterSeconds} from a gap already sampled ({@link minGapMinutes} of the same trigger and
 * time), so a caller that checked the interval does not walk the 50 ticks again; null gap is 0.
 */
export function jitterForGap(taskId: string, gap: number | null): number {
  if (gap === null) return 0;
  const range = Math.min(Math.floor(0.1 * gap * 60), JITTER_CAP_SECONDS);
  return range > 0 ? fnv1a32(taskId) % range : 0;
}

/**
 * The ticks in (lastTick, now], without walking them (spec §6 step 1): `fire` is the latest one
 * when it lies inside the catch-up window, else null; `firstMissed` is the earliest of the others
 * (every tick but `fire`), which the scanner records as one skipped run, or null when there are
 * none. The latest tick is found by widening a window back from `now` (1 minute, doubling) until
 * it holds a tick, then stepping forward inside it, so a month-long outage costs a handful of tick
 * computations, not thousands.
 */
export function dueTicks(
  t: ScheduleTrigger,
  lastTick: Date,
  now: Date,
  catchUpWindowMinutes: number,
): { fire: Date | null; firstMissed: Date | null } {
  const next = ticker(t);
  const end = now.getTime();
  const first = next(lastTick);
  if (!first || first.getTime() > end) return { fire: null, firstMissed: null };
  const latest = latestTick(next, lastTick.getTime(), end) ?? first;
  const fire = latest.getTime() >= end - catchUpWindowMinutes * 60000 ? latest : null;
  const missed = fire === null || first.getTime() < fire.getTime();
  return { fire, firstMissed: missed ? first : null };
}

/** The latest tick in (lastMs, endMs]; null when there is none. */
function latestTick(
  next: (after: Date) => Date | null,
  lastMs: number,
  endMs: number,
): Date | null {
  let from: Date | null = null;
  for (let span = 60_000; ; span *= 2) {
    const lo = Math.max(endMs - span, lastMs);
    const tick = next(new Date(lo));
    if (tick && tick.getTime() <= endMs) {
      from = tick;
      break;
    }
    if (lo === lastMs) return null;
  }
  let latest = from;
  for (;;) {
    const n = next(latest);
    if (!n || n.getTime() > endMs) return latest;
    latest = n;
  }
}
