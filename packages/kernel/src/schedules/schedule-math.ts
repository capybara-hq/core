import { CronTime } from "cron";
import { isTimeZone } from "../time-zone.js";
import type { ScheduleTrigger } from "./types.js";

/** Spec §5: how many upcoming fire times the minimum-interval check looks at. */
const GAP_SAMPLE = 50;
const JITTER_CAP_SECONDS = 300;
/** Cap on the ticks enumerated before the catch-up window (a 5-minute task is ~288 a day). */
const MAX_OLD_TICKS = 5000;
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

/** How far back a DST transition can move a tick: longer than any gap (spec §5). */
const TRANSITION_LOOKBACK_MS = 6 * 3600_000;

/**
 * {@link nextTick} for one trigger, with its `CronTime`s built once: callers that walk many ticks
 * (the gap sample, the catch-up enumeration) reuse one ticker instead of rebuilding per tick.
 */
function ticker(t: ScheduleTrigger): (after: Date) => Date | null {
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

/** The wall clock of `at` in `timeZone`, read as if it were UTC (epoch ms, seconds dropped). */
function localWallClock(at: Date, timeZone: string): number {
  return Math.floor(wallOf(at.getTime(), timeZone) / 60000) * 60000;
}

/** The smallest gap, in minutes, among the next 50 fire times after `from`; null for once. */
export function minGapMinutes(t: ScheduleTrigger, from: Date): number | null {
  if (t.kind === "once") return null;
  const key = `${t.expr}\u0000${t.timeZone}\u0000${from.getTime()}`;
  if (gapMemo.has(key)) return gapMemo.get(key) ?? null;
  const gap = sampleGap(t, from);
  if (gapMemo.size >= GAP_MEMO_SIZE) {
    const oldest = gapMemo.keys().next().value;
    if (oldest !== undefined) gapMemo.delete(oldest);
  }
  gapMemo.set(key, gap);
  return gap;
}

/** Bound of {@link gapMemo}. */
const GAP_MEMO_SIZE = 256;

/**
 * Recent {@link minGapMinutes} results by (expression, zone, from): a create validates the gap and
 * then derives the jitter from the same sample, and each sample walks 50 ticks of `CronTime`
 * (about 0.2 ms each). The function is pure, so a bounded per-process cache is safe.
 */
const gapMemo = new Map<string, number | null>();

function sampleGap(t: ScheduleTrigger & { kind: "cron" }, from: Date): number | null {
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
  const gap = minGapMinutes(t, from);
  if (gap === null) return 0;
  const range = Math.min(Math.floor(0.1 * gap * 60), JITTER_CAP_SECONDS);
  return range > 0 ? fnv1a32(taskId) % range : 0;
}

/**
 * The ticks in (lastTick, now]. `fire` is the latest one when it lies inside the catch-up window,
 * else null (spec §6 step 1). `missed` lists the others, oldest first, and is exact unless the
 * outage is long: at most the first 5000 ticks after `lastTick` are listed, then the ticks inside
 * the window, so enumeration stays bounded and the in-window tick is never lost. Callers record
 * `missed` as one skipped run, so a non-empty list is what matters.
 */
export function dueTicks(
  t: ScheduleTrigger,
  lastTick: Date,
  now: Date,
  catchUpWindowMinutes: number,
): { fire: Date | null; missed: Date[] } {
  const windowStart = now.getTime() - catchUpWindowMinutes * 60000;
  const ticks: Date[] = [];
  let cursor = lastTick;
  let old = 0;
  let jumped = false;
  const tickAfter = ticker(t);
  for (let guard = 0; guard < 2 * MAX_OLD_TICKS + 10000; guard++) {
    const next = tickAfter(cursor);
    if (!next || next.getTime() > now.getTime()) break;
    ticks.push(next);
    cursor = next;
    if (!jumped && next.getTime() < windowStart && ++old >= MAX_OLD_TICKS) {
      jumped = true;
      // Skip the middle of a very long outage; resume at the window so `fire` is found.
      if (cursor.getTime() < windowStart - 1) cursor = new Date(windowStart - 1);
    }
  }
  const latest = ticks.at(-1);
  if (!latest) return { fire: null, missed: [] };
  return latest.getTime() >= windowStart
    ? { fire: latest, missed: ticks.slice(0, -1) }
    : { fire: null, missed: ticks };
}
