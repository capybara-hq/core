import type { CalendarCollapsed, CalendarItem, ScheduleTrigger, TaskRunStatus } from "./schedules";

/**
 * The calendar view of `/schedules` (calendar spec §4, §9), pure: the view and range kept in the
 * address and the `cap_schedules_view` cookie, the days a range shows, its bounds in the viewer's
 * zone, where an instant sits on the grid, the range label and the words for a collapsed task.
 * Days are `YYYY-MM-DD` strings in the viewer's zone; nothing here reads the clock.
 */

export type SchedulesView = "list" | "calendar";
export type CalendarRange = "week" | "month";
export type CalendarScope = "mine" | "all";
export type CalendarItemState = "upcoming" | "running" | "completed" | "failed" | "skipped";

/** What the address says (`?view=list`, or the calendar's `?range=week|month&date=YYYY-MM-DD&scope=all`). */
export interface SchedulesUrl {
  view: SchedulesView;
  range: CalendarRange;
  /** A day of the shown week or month; null: today. */
  date: string | null;
  scope: CalendarScope;
}

/** The last chosen tab and range, per browser (calendar spec §4.1, Q5). */
export const SCHEDULES_VIEW_COOKIE = "cap_schedules_view";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Whether `s` is a `YYYY-MM-DD` day that exists. */
export function isDay(s: string | null | undefined): s is string {
  if (s == null || !DAY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const parseView = (v: string | null | undefined): SchedulesView | undefined =>
  v === "list" || v === "calendar" ? v : undefined;
const parseRange = (v: string | null | undefined): CalendarRange | undefined =>
  v === "week" || v === "month" ? v : undefined;

/** The cookie's view and range (`calendar.month`); anything else reads as nothing. */
export function parseViewCookie(value: string | undefined): {
  view?: SchedulesView;
  range?: CalendarRange;
} {
  const [v, r] = (value ?? "").split(".");
  const view = parseView(v);
  const range = parseRange(r);
  return { ...(view ? { view } : {}), ...(range ? { range } : {}) };
}

/** The cookie a choice of tab and range writes (`SameSite=Lax`, a year, the whole site). */
export function viewCookie(view: SchedulesView, range: CalendarRange): string {
  return `${SCHEDULES_VIEW_COOKIE}=${view}.${range}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

type SearchLike = URLSearchParams | Record<string, string | string[] | undefined>;

function param(search: SearchLike, name: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(name) ?? undefined;
  const v = search[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The effective state of the page: the address wins, then the cookie (the view and the range), then
 * the calendar and the week. The admin scope is never remembered.
 */
export function schedulesUrlOf(search: SearchLike, cookie?: string): SchedulesUrl {
  const remembered = parseViewCookie(cookie);
  const date = param(search, "date");
  return {
    view: parseView(param(search, "view")) ?? remembered.view ?? "calendar",
    range: parseRange(param(search, "range")) ?? remembered.range ?? "week",
    date: isDay(date) ? date : null,
    scope: param(search, "scope") === "all" ? "all" : "mine",
  };
}

/** The address of a state (`?view=list` for the list; the calendar with what differs). */
export function schedulesSearch(s: SchedulesUrl): string {
  if (s.view === "list") return "?view=list";
  const q = new URLSearchParams();
  if (s.range === "month") q.set("range", "month");
  if (s.date !== null) q.set("date", s.date);
  if (s.scope === "all") q.set("scope", "all");
  const query = q.toString();
  return query === "" ? "" : `?${query}`;
}

// ---- days and instants in a zone ----

const formats = new Map<string, Intl.DateTimeFormat>();

function wallOf(ms: number, timeZone: string) {
  let f = formats.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The viewer-local day of an instant. */
export function dayIn(ms: number, timeZone: string): string {
  const w = wallOf(ms, timeZone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Minutes after the viewer-local midnight of an instant (0..1439). */
export function minuteIn(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone);
  return w.h * 60 + w.mi;
}

/** Where an instant sits on the grid: its viewer-local day, minute and `HH:mm` (one zone read). */
export function placeIn(
  ms: number,
  timeZone: string,
): { day: string; minute: number; time: string } {
  const w = wallOf(ms, timeZone);
  return {
    day: `${w.y}-${pad(w.m)}-${pad(w.d)}`,
    minute: w.h * 60 + w.mi,
    time: `${pad(w.h)}:${pad(w.mi)}`,
  };
}

/** `HH:mm` of an instant in the zone. */
export function timeIn(ms: number, timeZone: string): string {
  const w = wallOf(ms, timeZone);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

/** The zone's offset at an instant (ms to add to UTC to get the wall clock). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The first instant of a viewer-local day (its midnight, or the first time after a DST gap). */
export function startOfDay(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetAt(wall, timeZone);
  t = wall - offsetAt(t, timeZone);
  // a midnight in a DST gap does not exist: the day starts at the first instant on it
  if (dayIn(t, timeZone) !== day) {
    for (const step of [3600_000, 1800_000]) {
      if (dayIn(t + step, timeZone) === day && dayIn(t, timeZone) < day) return t + step;
    }
  }
  return t;
}

/** `day` moved by `n` days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday 0 … Sunday 6. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The days a range shows: the Monday-first week of `date`, or the 6 × 7 days around its month. */
export function rangeDays(range: CalendarRange, date: string): string[] {
  const first = range === "week" ? date : `${date.slice(0, 7)}-01`;
  const monday = addDays(first, -weekdayOf(first));
  return Array.from({ length: range === "week" ? 7 : 42 }, (_, i) => addDays(monday, i));
}

/** The instants a range covers: the viewer-local start of its first day and of the day after. */
export function rangeBounds(
  range: CalendarRange,
  date: string,
  timeZone: string,
): { from: string; to: string } {
  const days = rangeDays(range, date);
  const last = days[days.length - 1] as string;
  return {
    from: new Date(startOfDay(days[0] as string, timeZone)).toISOString(),
    to: new Date(startOfDay(addDays(last, 1), timeZone)).toISOString(),
  };
}

/** The previous or next week (a day 7 away) or month (its first day). */
export function shiftDate(range: CalendarRange, date: string, dir: -1 | 1): string {
  if (range === "week") return addDays(date, 7 * dir);
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
}

/** 「2026-11-09 – 11-15」 (the year again when the week crosses one) / 「2026-11」. */
export function rangeLabel(range: CalendarRange, date: string): string {
  if (range === "month") return date.slice(0, 7);
  const days = rangeDays("week", date);
  const first = days[0] as string;
  const last = days[6] as string;
  return `${first} – ${last.slice(0, 4) === first.slice(0, 4) ? last.slice(5) : last}`;
}

// ---- items ----

/** A run's state on the calendar (`pending` is drawn as running: it is on its way). */
export function runState(status: TaskRunStatus): CalendarItemState {
  return status === "pending" ? "running" : status;
}

/** The state of an item. */
export const itemState = (it: CalendarItem): CalendarItemState =>
  it.kind === "occurrence" ? "upcoming" : runState(it.status);

/** One state for a collapsed task-day: running, then failed, then what the day mostly is. */
export function collapsedState(c: CalendarCollapsed): CalendarItemState {
  if (c.running > 0) return "running";
  if (c.failed > 0) return "failed";
  if (c.upcoming === c.count) return "upcoming";
  if (c.completed > 0) return "completed";
  if (c.skipped === c.count) return "skipped";
  return "upcoming";
}

/** The instant an item is drawn at: its tick (a manual run at its request time). */
export const itemInstant = (it: CalendarItem): number => Date.parse(it.scheduledFor);

/**
 * The run panel's address (`#run=<taskRunId>`, `#at=<taskId>/<ISO tick>`, `#day=<taskId>/<day>`;
 * an item opened from a collapsed day keeps the day first: `#day=<taskId>/<day>&run=<id>`, so its
 * Back and a reload return to the day). Also the calendar's item ids.
 */
export type RunPanelRef =
  | { kind: "run"; id: string }
  | { kind: "at"; taskId: string; at: string }
  | { kind: "day"; taskId: string; day: string; open?: RunPanelRef };

export function refId(r: RunPanelRef): string {
  switch (r.kind) {
    case "run":
      return `run=${r.id}`;
    case "at":
      return `at=${r.taskId}/${r.at}`;
    case "day":
      return `day=${r.taskId}/${r.day}${r.open ? `&${refId(r.open)}` : ""}`;
  }
}

function parseOne(part: string): RunPanelRef | null {
  const eq = part.indexOf("=");
  if (eq < 0) return null;
  const kind = part.slice(0, eq);
  const value = part.slice(eq + 1);
  if (kind === "run") return value === "" ? null : { kind: "run", id: value };
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const taskId = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (kind === "at")
    return Number.isNaN(Date.parse(rest)) ? null : { kind: "at", taskId, at: rest };
  if (kind === "day") return isDay(rest) ? { kind: "day", taskId, day: rest } : null;
  return null;
}

/** The panel a hash names (`#run=…`), or null. */
export function parseRunPanelRef(hash: string): RunPanelRef | null {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const [head, tail] = raw.split("&");
  const first = parseOne(head ?? "");
  if (first === null) return null;
  if (first.kind !== "day" || tail === undefined) return first;
  const open = parseOne(tail);
  return open !== null && open.kind !== "day" ? { ...first, open } : first;
}

/** The id the calendar component gives an item. */
export function itemRef(it: CalendarItem): RunPanelRef {
  return it.kind === "run"
    ? { kind: "run", id: it.id }
    : { kind: "at", taskId: it.taskId, at: it.scheduledFor };
}

/**
 * The words for a collapsed task-day from its trigger (calendar spec §5.4): a fixed step of
 * minutes (`*\/15 * * * *`), of an hour (`0 * * * *`) or of hours (`0 *\/2 * * *`); anything else is
 * only the count.
 */
export function collapsedWords(
  trigger: ScheduleTrigger,
):
  | { key: "minutes"; n: number }
  | { key: "hourly" }
  | { key: "hours"; n: number }
  | { key: "runs" } {
  if (trigger.kind !== "cron") return { key: "runs" };
  const f = trigger.expr.trim().split(/\s+/);
  if (f.length !== 5) return { key: "runs" };
  const [mi = "", h = "", dom = "", mon = "", dow = ""] = f;
  if (dom !== "*" || mon !== "*" || dow !== "*") return { key: "runs" };
  const step = (s: string, max: number) => {
    const m = /^(?:\*|0)\/(\d{1,2})$/.exec(s);
    const n = m ? Number(m[1]) : Number.NaN;
    return n >= 1 && n < max ? n : null;
  };
  const minuteStep = step(mi, 60);
  if (minuteStep !== null && h === "*") return { key: "minutes", n: minuteStep };
  if (/^\d{1,2}$/.test(mi) && Number(mi) < 60) {
    if (h === "*") return { key: "hourly" };
    const hourStep = step(h, 24);
    if (hourStep !== null) return { key: "hours", n: hourStep };
  }
  return { key: "runs" };
}
