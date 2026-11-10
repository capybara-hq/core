import { CronTime } from "cron";
import { isTimeZone } from "../time-zone.js";
import type { ScheduleTrigger } from "./types.js";

/** Spec §5: how many upcoming fire times the minimum-interval check looks at. */
const GAP_SAMPLE = 50;
const JITTER_CAP_SECONDS = 300;
/** Safety cap on the ticks enumerated for one catch-up (a 5-minute task is ~288 a day). */
const MAX_TICKS = 5000;
const LOCAL_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type TriggerError =
  | "schedule.invalid_cron"
  | "schedule.invalid_time_zone"
  | "schedule.once_in_past";

function cronTime(expr: string, timeZone: string): CronTime | null {
  if (expr.trim().split(/\s+/).length !== 5) return null;
  try {
    return new CronTime(expr.trim(), timeZone);
  } catch {
    return null;
  }
}

/** The UTC instant of a local date-time (no offset) in `timeZone`; null when malformed. */
function onceInstant(at: string, timeZone: string): Date | null {
  const m = LOCAL_AT.exec(at);
  if (!m) return null;
  const n = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const wall = Date.UTC(n[0] ?? 0, (n[1] ?? 1) - 1, n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0);
  if (Number.isNaN(wall)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsetAt = (utc: number): number => {
    const p: Record<string, string | undefined> = Object.fromEntries(
      fmt.formatToParts(new Date(utc)).map((x) => [x.type, x.value]),
    );
    const local = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return local - Math.floor(utc / 1000) * 1000;
  };
  // Two passes settle the offset; a time inside a DST gap resolves to just after the gap.
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc);
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
  if (!at || at.getTime() <= now.getTime()) return { ok: false, code: "schedule.once_in_past" };
  return { ok: true };
}

/** The first tick strictly after `after` (before jitter); null for a past once task. */
export function nextTick(t: ScheduleTrigger, after: Date): Date | null {
  if (t.kind === "once") {
    const at = onceInstant(t.at, t.timeZone);
    return at && at.getTime() > after.getTime() ? at : null;
  }
  const time = cronTime(t.expr, t.timeZone);
  const wallTime = cronTime(t.expr, "UTC");
  if (!time || !wallTime) return null;
  let cursor = after;
  for (let i = 0; i < 10; i++) {
    const tick = new Date(time.getNextDateFrom(cursor, t.timeZone).toMillis());
    // CronTime moves a tick that falls in a DST gap to the next valid instant; the spec says a
    // skipped local time does not fire, so keep only ticks whose wall clock the expression names.
    const wall = localWallClock(tick, t.timeZone);
    if (wallTime.getNextDateFrom(new Date(wall - 1000), "UTC").toMillis() === wall) return tick;
    cursor = tick;
  }
  return null;
}

/** The wall clock of `at` in `timeZone`, read as if it were UTC (epoch ms, seconds dropped). */
function localWallClock(at: Date, timeZone: string): number {
  const p: Record<string, string | undefined> = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
  );
}

/** The smallest gap, in minutes, among the next 50 fire times after `from`; null for once. */
export function minGapMinutes(t: ScheduleTrigger, from: Date): number | null {
  if (t.kind === "once") return null;
  let prev = nextTick(t, from);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; prev && i < GAP_SAMPLE; i++) {
    const next = nextTick(t, prev);
    if (!next) break;
    min = Math.min(min, (next.getTime() - prev.getTime()) / 60000);
    prev = next;
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
 * The ticks in (lastTick, now]: the latest inside the catch-up window is `fire`; every other one
 * (older ticks, and the latest too when it fell outside the window) is `missed` (spec §6 step 1).
 */
export function dueTicks(
  t: ScheduleTrigger,
  lastTick: Date,
  now: Date,
  catchUpWindowMinutes: number,
): { fire: Date | null; missed: Date[] } {
  const ticks: Date[] = [];
  let cursor = lastTick;
  while (ticks.length < MAX_TICKS) {
    const next = nextTick(t, cursor);
    if (!next || next.getTime() > now.getTime()) break;
    ticks.push(next);
    cursor = next;
  }
  const latest = ticks.at(-1);
  if (!latest) return { fire: null, missed: [] };
  const inWindow = now.getTime() - latest.getTime() <= catchUpWindowMinutes * 60000;
  return inWindow ? { fire: latest, missed: ticks.slice(0, -1) } : { fire: null, missed: ticks };
}
