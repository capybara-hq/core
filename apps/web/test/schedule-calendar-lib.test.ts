import { describe, expect, it } from "vitest";
import {
  collapsedState,
  collapsedWords,
  dayIn,
  isDay,
  minuteIn,
  parseRunPanelRef,
  parseViewCookie,
  rangeBounds,
  rangeDays,
  rangeLabel,
  refId,
  schedulesSearch,
  schedulesUrlOf,
  shiftDate,
  startOfDay,
  viewCookie,
} from "../src/lib/schedule-calendar";

const SH = "Asia/Shanghai";
const NY = "America/New_York";

describe("schedule calendar: address and cookie", () => {
  it("the address wins over the cookie, the cookie over the list and the week", () => {
    expect(schedulesUrlOf({})).toEqual({ view: "list", range: "week", date: null, scope: "mine" });
    expect(schedulesUrlOf({}, "calendar.month")).toMatchObject({
      view: "calendar",
      range: "month",
    });
    expect(schedulesUrlOf({ view: "list" }, "calendar.month")).toMatchObject({
      view: "list",
      range: "month",
    });
    expect(
      schedulesUrlOf(new URLSearchParams("view=calendar&range=week&date=2026-11-12&scope=all")),
    ).toEqual({ view: "calendar", range: "week", date: "2026-11-12", scope: "all" });
    // nonsense reads as nothing
    expect(schedulesUrlOf({ view: "grid", date: "2026-02-30" }, "x.y")).toEqual({
      view: "list",
      range: "week",
      date: null,
      scope: "mine",
    });
  });

  it("writes the calendar's address with what differs, the list as the bare page", () => {
    const base = { view: "calendar", range: "week", date: null, scope: "mine" } as const;
    expect(schedulesSearch(base)).toBe("?view=calendar");
    expect(schedulesSearch({ ...base, range: "month", date: "2026-11-01", scope: "all" })).toBe(
      "?view=calendar&range=month&date=2026-11-01&scope=all",
    );
    expect(schedulesSearch({ ...base, view: "list" })).toBe("");
  });

  it("the cookie holds the tab and the range for a year, Lax", () => {
    expect(viewCookie("calendar", "month")).toBe(
      "cap_schedules_view=calendar.month; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(parseViewCookie("list.week")).toEqual({ view: "list", range: "week" });
    expect(parseViewCookie(undefined)).toEqual({});
  });

  it("checks days", () => {
    expect(isDay("2026-11-12")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("11-12")).toBe(false);
  });
});

describe("schedule calendar: ranges", () => {
  it("a week is Monday first, a month 6 × 7 days from the Monday on or before the 1st", () => {
    expect(rangeDays("week", "2026-11-12")).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    // a Sunday belongs to the week before
    expect(rangeDays("week", "2026-11-15")[0]).toBe("2026-11-09");
    const month = rangeDays("month", "2026-11-20");
    expect(month).toHaveLength(42);
    expect(month[0]).toBe("2026-10-26");
    expect(month[41]).toBe("2026-12-06");
  });

  it("bounds are the viewer-local start of the first day and of the day after the last", () => {
    expect(rangeBounds("week", "2026-11-12", SH)).toEqual({
      from: "2026-11-08T16:00:00.000Z",
      to: "2026-11-15T16:00:00.000Z",
    });
    // a viewer DST week in New York (Sunday 2026-11-01 falls back): 169 hours
    const { from, to } = rangeBounds("week", "2026-10-28", NY);
    expect(from).toBe("2026-10-26T04:00:00.000Z");
    expect(to).toBe("2026-11-02T05:00:00.000Z");
    expect((Date.parse(to) - Date.parse(from)) / 3600_000).toBe(169);
    // spring forward (2026-03-08): 167 hours
    const spring = rangeBounds("week", "2026-03-04", NY);
    expect((Date.parse(spring.to) - Date.parse(spring.from)) / 3600_000).toBe(167);
  });

  it("a midnight in a DST gap starts the day at its first instant", () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06: the day starts at 01:00
    const t = startOfDay("2026-09-06", "America/Santiago");
    expect(dayIn(t, "America/Santiago")).toBe("2026-09-06");
    expect(dayIn(t - 1, "America/Santiago")).toBe("2026-09-05");
  });

  it("steps a week by seven days and a month to its neighbour's first day", () => {
    expect(shiftDate("week", "2026-11-12", 1)).toBe("2026-11-19");
    expect(shiftDate("week", "2026-01-02", -1)).toBe("2025-12-26");
    expect(shiftDate("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDate("month", "2026-01-15", -1)).toBe("2025-12-01");
  });

  it("labels a week by its days and a month by its year and month", () => {
    expect(rangeLabel("week", "2026-11-12")).toBe("2026-11-09 – 11-15");
    expect(rangeLabel("week", "2026-12-31")).toBe("2026-12-28 – 2027-01-03");
    expect(rangeLabel("month", "2026-11-12")).toBe("2026-11");
  });
});

describe("schedule calendar: placement", () => {
  it("places an instant on the viewer's day and minute, across a viewer DST day", () => {
    // 2026-11-01 01:30 happens twice in New York: both land on the same rows
    const first = Date.parse("2026-11-01T05:30:00Z");
    const second = Date.parse("2026-11-01T06:30:00Z");
    expect([dayIn(first, NY), minuteIn(first, NY)]).toEqual(["2026-11-01", 90]);
    expect([dayIn(second, NY), minuteIn(second, NY)]).toEqual(["2026-11-01", 90]);
  });

  it("a task in another zone sits at the viewer's time", () => {
    // 09:00 in New York is 22:00 in Shanghai
    const tick = Date.parse("2026-11-12T14:00:00Z");
    expect([dayIn(tick, SH), minuteIn(tick, SH)]).toEqual(["2026-11-12", 22 * 60]);
    expect([dayIn(tick, NY), minuteIn(tick, NY)]).toEqual(["2026-11-12", 9 * 60]);
  });
});

describe("schedule calendar: the run panel's hash", () => {
  it("round-trips a run, an occurrence, a day and an item opened from a day", () => {
    const refs = [
      { kind: "run", id: "tr1" },
      { kind: "at", taskId: "s1", at: "2026-11-12T01:00:00.000Z" },
      { kind: "day", taskId: "s1", day: "2026-11-12" },
      { kind: "day", taskId: "s1", day: "2026-11-12", open: { kind: "run", id: "tr2" } },
    ] as const;
    for (const r of refs) expect(parseRunPanelRef(`#${refId(r)}`)).toEqual(r);
    expect(parseRunPanelRef("#properties")).toBeNull();
    expect(parseRunPanelRef("#day=s1/2026-13-01")).toBeNull();
    expect(parseRunPanelRef("")).toBeNull();
  });
});

describe("schedule calendar: collapsed tasks", () => {
  const cron = (expr: string) => ({ kind: "cron", expr, timeZone: SH }) as const;

  it("names a fixed step, else only the count", () => {
    expect(collapsedWords(cron("*/15 * * * *"))).toEqual({ key: "minutes", n: 15 });
    expect(collapsedWords(cron("0 * * * *"))).toEqual({ key: "hourly" });
    expect(collapsedWords(cron("5 */2 * * *"))).toEqual({ key: "hours", n: 2 });
    expect(collapsedWords(cron("0 9-17 * * *"))).toEqual({ key: "runs" });
    expect(collapsedWords(cron("*/15 * * * 1-5"))).toEqual({ key: "runs" });
    expect(collapsedWords({ kind: "once", at: "2026-11-12T09:00", timeZone: SH })).toEqual({
      key: "runs",
    });
  });

  it("one state for the day: running, then failed, then what it mostly is", () => {
    const c = {
      taskId: "s1",
      day: "2026-11-12",
      count: 24,
      upcoming: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      first: "",
      last: "",
    };
    expect(collapsedState({ ...c, running: 1, failed: 2, completed: 21 })).toBe("running");
    expect(collapsedState({ ...c, failed: 2, completed: 22 })).toBe("failed");
    expect(collapsedState({ ...c, upcoming: 24 })).toBe("upcoming");
    expect(collapsedState({ ...c, completed: 10, upcoming: 14 })).toBe("completed");
    expect(collapsedState({ ...c, skipped: 24 })).toBe("skipped");
  });
});
