import { describe, expect, it } from "vitest";
import {
  assembleCalendar,
  CALENDAR_LIMITS,
  type CalendarInput,
  type CalendarItem,
  dayKey,
  startOfLocalDay,
} from "../../src/schedules/calendar.js";
import { nextTick } from "../../src/schedules/schedule-math.js";
import type { ScheduledTask, ScheduleTrigger, TaskRun } from "../../src/schedules/types.js";

const ME = "acct-me";
const OTHER = "acct-other";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-12T03:30:00Z");

const cron = (expr: string, timeZone = "UTC"): ScheduleTrigger => ({
  kind: "cron",
  expr,
  timeZone,
});

/** An active task whose next_run_at is the first tick after NOW plus its jitter. */
function task(id: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  const trigger = over.trigger ?? cron("0 9 * * *");
  const jitterSeconds = over.jitterSeconds ?? 0;
  const tick = nextTick(trigger, NOW);
  return {
    id,
    orgId: "org",
    accountId: ME,
    agentId: "agent",
    name: id,
    prompt: "p",
    trigger,
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    pauseReason: null,
    pausedBy: null,
    nextRunAt: tick ? new Date(tick.getTime() + jitterSeconds * 1000) : null,
    jitterSeconds,
    expiresAt: null,
    consecutiveFailures: 0,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...over,
  };
}

function run(taskId: string, scheduledFor: string, over: Partial<TaskRun> = {}): TaskRun {
  return {
    id: `run-${taskId}-${scheduledFor}`,
    taskId,
    orgId: "org",
    scheduledFor: new Date(scheduledFor),
    firedAt: new Date(scheduledFor),
    trial: false,
    manual: false,
    conversationId: "conv-1",
    runId: "r-1",
    status: "completed",
    skipReason: null,
    error: null,
    missingGrants: [],
    ...over,
  };
}

function input(over: Partial<CalendarInput> = {}): CalendarInput {
  return {
    tasks: [],
    runs: [],
    viewerAccountId: ME,
    from: new Date("2026-11-09T00:00:00Z"),
    to: new Date("2026-11-16T00:00:00Z"),
    timeZone: "UTC",
    now: NOW,
    plan: true,
    catchUpWindowMinutes: 60,
    collapse: true,
    ...over,
  };
}

const occurrences = (items: CalendarItem[]) =>
  items.filter((i) => i.kind === "occurrence").map((i) => i.scheduledFor);

describe("assembleCalendar", () => {
  it("plans from next_run_at - jitter: the first occurrence is the scanner's next tick", () => {
    const t = task("daily", { jitterSeconds: 120 });
    const a = assembleCalendar(input({ tasks: [t] }));
    expect(occurrences(a.items)).toEqual([
      "2026-11-12T09:00:00.000Z",
      "2026-11-13T09:00:00.000Z",
      "2026-11-14T09:00:00.000Z",
      "2026-11-15T09:00:00.000Z",
    ]);
    expect(a.items[0]).toEqual({
      kind: "occurrence",
      taskId: "daily",
      scheduledFor: "2026-11-12T09:00:00.000Z",
      at: "2026-11-12T09:02:00.000Z",
    });
    expect(a.tasks.map((x) => x.id)).toEqual(["daily"]);
    expect(a.truncated).toBe(false);
    expect(a.horizon).toBe(new Date(NOW.getTime() + 42 * DAY).toISOString());
  });

  it("a next_run_at later than the schedule's next tick starts there (no earlier tick)", () => {
    // e.g. a task resumed or created later: the scanner fires nothing before its due tick
    const t = task("daily", { nextRunAt: new Date("2026-11-14T09:00:00Z") });
    expect(occurrences(assembleCalendar(input({ tasks: [t] })).items)[0]).toBe(
      "2026-11-14T09:00:00.000Z",
    );
  });

  it("keeps a due tick the scan has not recorded; drops one older than the catch-up window", () => {
    // due at 03:00 (+30 s jitter), now 03:30: the scan fires it at its next minute
    const hourly = cron("0 * * * *");
    const due = task("due", {
      trigger: hourly,
      jitterSeconds: 30,
      nextRunAt: new Date("2026-11-12T03:00:30Z"),
    });
    const a = assembleCalendar(input({ tasks: [due], to: new Date("2026-11-12T06:00:00Z") }));
    expect(occurrences(a.items)).toEqual([
      "2026-11-12T03:00:00.000Z",
      "2026-11-12T04:00:00.000Z",
      "2026-11-12T05:00:00.000Z",
    ]);
    // the scanner was down since 01:00: 01:00 and 02:00 become one missed run, 03:00 fires
    const late = { ...due, nextRunAt: new Date("2026-11-12T01:00:30Z") };
    expect(
      occurrences(
        assembleCalendar(input({ tasks: [late], to: new Date("2026-11-12T06:00:00Z") })).items,
      ),
    ).toEqual(["2026-11-12T03:00:00.000Z", "2026-11-12T04:00:00.000Z", "2026-11-12T05:00:00.000Z"]);
    // a 20-minute window: 03:00 is older than now - 20 min, so nothing due fires
    expect(
      occurrences(
        assembleCalendar(
          input({ tasks: [late], to: new Date("2026-11-12T06:00:00Z"), catchUpWindowMinutes: 20 }),
        ).items,
      ),
    ).toEqual(["2026-11-12T04:00:00.000Z", "2026-11-12T05:00:00.000Z"]);
  });

  it("a recorded tick is shown as its run, not again as an occurrence (a trial run does not count)", () => {
    const t = task("daily");
    const a = assembleCalendar(
      input({
        tasks: [t],
        runs: [
          run("daily", "2026-11-12T09:00:00Z", { status: "pending", firedAt: null }),
          run("daily", "2026-11-13T09:00:00Z", { trial: true, manual: true, id: "trial" }),
        ],
      }),
    );
    const day12 = a.items.filter((i) => i.scheduledFor.startsWith("2026-11-12"));
    expect(day12).toHaveLength(1);
    expect(day12[0]).toMatchObject({ kind: "run", status: "pending" });
    const day13 = a.items.filter((i) => i.scheduledFor.startsWith("2026-11-13"));
    expect(day13.map((i) => i.kind).sort()).toEqual(["occurrence", "run"]);
  });

  it("paused and ended tasks show their runs and no occurrences; plan=false plans nothing", () => {
    const paused = task("paused", { status: "paused", nextRunAt: null });
    const ended = task("ended", { status: "ended", nextRunAt: null });
    const live = task("live");
    const runs = [run("paused", "2026-11-10T09:00:00Z"), run("ended", "2026-11-10T09:00:00Z")];
    const a = assembleCalendar(input({ tasks: [paused, ended, live], runs }));
    expect(a.items.filter((i) => i.kind === "run").map((i) => i.taskId)).toEqual([
      "ended",
      "paused",
    ]);
    expect(new Set(a.items.filter((i) => i.kind === "occurrence").map((i) => i.taskId))).toEqual(
      new Set(["live"]),
    );
    const off = assembleCalendar(input({ tasks: [paused, ended, live], runs, plan: false }));
    expect(occurrences(off.items)).toEqual([]);
    expect(off.items).toHaveLength(2);
    expect(off.tasks.map((x) => x.id).sort()).toEqual(["ended", "paused"]);
  });

  it("another creator's runs lose conversationId, error and missingGrants", () => {
    const mine = task("mine");
    const theirs = task("theirs", { accountId: OTHER });
    const detail = {
      status: "failed" as const,
      error: "boom",
      conversationId: "conv-x",
      missingGrants: ["a", "b"],
    };
    const a = assembleCalendar(
      input({
        tasks: [mine, theirs],
        runs: [
          run("mine", "2026-11-10T09:00:00Z", detail),
          run("theirs", "2026-11-10T09:00:00Z", detail),
        ],
        plan: false,
      }),
    );
    expect(a.items).toEqual([
      expect.objectContaining({
        taskId: "mine",
        conversationId: "conv-x",
        error: "boom",
        missingGrants: 2,
      }),
      expect.objectContaining({
        taskId: "theirs",
        status: "failed",
        conversationId: null,
        error: null,
        missingGrants: null,
      }),
    ]);
  });

  it("stops at expires_at and at the 42-day horizon", () => {
    const t = task("daily", { expiresAt: new Date("2026-11-13T09:00:00Z") });
    expect(occurrences(assembleCalendar(input({ tasks: [t] })).items)).toEqual([
      "2026-11-12T09:00:00.000Z",
      "2026-11-13T09:00:00.000Z",
    ]);
    const far = assembleCalendar(
      input({
        tasks: [task("daily")],
        from: new Date("2026-12-20T00:00:00Z"),
        to: new Date("2027-01-01T00:00:00Z"),
      }),
    );
    // now + 42 days = 2026-12-24T03:30Z: the 24th's 09:00 is past it
    expect(occurrences(far.items).at(-1)).toBe("2026-12-23T09:00:00.000Z");
    expect(far.horizon).toBe("2026-12-24T03:30:00.000Z");
    expect(far.truncated).toBe(false);
  });

  it("collapses a task-day with more than 6 items, per local day of the viewer's zone", () => {
    const hourly = task("hourly", { trigger: cron("0 * * * *") });
    const three = task("three", { trigger: cron("0 8,12,18 * * *") });
    const a = assembleCalendar(
      input({
        tasks: [hourly, three],
        from: new Date("2026-11-13T00:00:00Z"),
        to: new Date("2026-11-15T00:00:00Z"),
        timeZone: "Asia/Shanghai",
        runs: [],
      }),
    );
    // Shanghai days: the 13th from 00:00Z (08:00 local) has 16 hours, the 14th 24, the 15th 8
    expect(a.collapsed.map((c) => [c.taskId, c.day, c.count, c.upcoming])).toEqual([
      ["hourly", "2026-11-13", 16, 16],
      ["hourly", "2026-11-14", 24, 24],
      ["hourly", "2026-11-15", 8, 8],
    ]);
    expect(a.collapsed[0]).toMatchObject({
      first: "2026-11-13T00:00:00.000Z",
      last: "2026-11-13T15:00:00.000Z",
    });
    expect(a.items.every((i) => i.taskId === "three")).toBe(true);
    expect(a.items).toHaveLength(6);
    expect(a.tasks.map((t) => t.id).sort()).toEqual(["hourly", "three"]);
  });

  it("counts a collapsed day's runs by state", () => {
    const hourly = task("hourly", {
      trigger: cron("0 * * * *"),
      nextRunAt: new Date("2026-11-12T04:00:00Z"),
    });
    const runs = [
      run("hourly", "2026-11-12T00:00:00Z"),
      run("hourly", "2026-11-12T01:00:00Z", { status: "failed" }),
      run("hourly", "2026-11-12T02:00:00Z", { status: "skipped", skipReason: "overlap" }),
      run("hourly", "2026-11-12T03:00:00Z", { status: "running" }),
    ];
    const a = assembleCalendar(
      input({
        tasks: [hourly],
        runs,
        from: new Date("2026-11-12T00:00:00Z"),
        to: new Date("2026-11-13T00:00:00Z"),
      }),
    );
    expect(a.items).toEqual([]);
    expect(a.collapsed).toEqual([
      {
        taskId: "hourly",
        day: "2026-11-12",
        count: 24,
        upcoming: 20,
        running: 1,
        completed: 1,
        failed: 1,
        skipped: 1,
        first: "2026-11-12T00:00:00.000Z",
        last: "2026-11-12T23:00:00.000Z",
      },
    ]);
  });

  it("never collapses with collapse=false (a taskId read)", () => {
    const hourly = task("hourly", { trigger: cron("0 * * * *") });
    const a = assembleCalendar(
      input({
        tasks: [hourly],
        from: new Date("2026-11-13T00:00:00Z"),
        to: new Date("2026-11-14T00:00:00Z"),
        collapse: false,
      }),
    );
    expect(a.collapsed).toEqual([]);
    expect(a.items).toHaveLength(24);
  });

  it("the tick budget cuts at a whole local day, counting every task's ticks of each day", () => {
    const tasks = ["a", "b", "c"].map((id) => task(id));
    // 3 ticks a day; the first day (13th) is outside the budget; budget 10: the 14th, 15th and
    // 16th fit (9), the 17th would be 12
    const a = assembleCalendar(
      input({
        tasks,
        from: new Date("2026-11-13T00:00:00Z"),
        to: new Date("2026-11-20T00:00:00Z"),
      }),
      { ...CALENDAR_LIMITS, tickBudget: 10 },
    );
    expect(a.truncated).toBe(true);
    expect(a.horizon).toBe("2026-11-17T00:00:00.000Z");
    expect(a.items).toHaveLength(12);
    expect(a.items.every((i) => i.scheduledFor < "2026-11-17")).toBe(true);
  });

  it("a cut in the viewer's zone lands on the local midnight", () => {
    const tasks = ["a", "b"].map((id) => task(id, { trigger: cron("0 9 * * *", "Asia/Shanghai") }));
    // 01:00Z ticks; the first local day is free (2); budget 3: the 14th fits (2), the 15th would
    // be 4
    const a = assembleCalendar(
      input({
        tasks,
        from: new Date("2026-11-12T16:00:00Z"),
        to: new Date("2026-11-16T16:00:00Z"),
        timeZone: "Asia/Shanghai",
      }),
      { ...CALENDAR_LIMITS, tickBudget: 3 },
    );
    expect(a.horizon).toBe("2026-11-14T16:00:00.000Z");
    expect(a.items).toHaveLength(4);
  });

  it("the item cap cuts at a whole day; collapsed task-days count as one entry", () => {
    const hourly = task("hourly", { trigger: cron("0 * * * *") });
    const tasks = [hourly, ...["a", "b"].map((id) => task(id))];
    // per day: 1 collapsed + 2 items = 3 entries; the first day is free; cap 7: the 14th and 15th
    // fit (6), the 16th would be 9
    const a = assembleCalendar(
      input({
        tasks,
        from: new Date("2026-11-13T00:00:00Z"),
        to: new Date("2026-11-20T00:00:00Z"),
      }),
      { ...CALENDAR_LIMITS, itemCap: 7 },
    );
    expect(a.truncated).toBe(true);
    expect(a.horizon).toBe("2026-11-16T00:00:00.000Z");
    expect(a.items.length + a.collapsed.length).toBe(9);
    expect(a.collapsed.map((c) => c.day)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("past the run-row bound, the range ends at the day of the first unread row", () => {
    const t = task("hourly", { trigger: cron("0 * * * *"), status: "paused", nextRunAt: null });
    const runs = Array.from({ length: 30 }, (_, i) =>
      run("hourly", new Date(Date.parse("2026-11-09T12:00:00Z") + i * HOUR).toISOString()),
    );
    // the 9th's 12 rows are free; runRowCap 5: the 10th's 6th row (05:00Z) is over it
    const a = assembleCalendar(input({ tasks: [t], runs }), { ...CALENDAR_LIMITS, runRowCap: 5 });
    expect(a.truncated).toBe(true);
    expect(a.horizon).toBe("2026-11-10T00:00:00.000Z");
    expect(a.collapsed.map((c) => [c.day, c.count])).toEqual([["2026-11-09", 12]]);
  });

  it("first day over the limits still returns the first day", () => {
    const tasks = ["a", "b", "c"].map((id) => task(id));
    const range = {
      tasks,
      from: new Date("2026-11-13T00:00:00Z"),
      to: new Date("2026-11-20T00:00:00Z"),
    };
    for (const limits of [
      { ...CALENDAR_LIMITS, tickBudget: 1 },
      { ...CALENDAR_LIMITS, itemCap: 1 },
      { ...CALENDAR_LIMITS, tickBudget: 0, itemCap: 0, runRowCap: 0 },
    ]) {
      const a = assembleCalendar(
        input({
          ...range,
          runs: [run("a", "2026-11-13T09:00:00Z"), run("a", "2026-11-14T09:00:00Z")],
        }),
        limits,
      );
      expect(a.truncated).toBe(true);
      expect(a.horizon).toBe("2026-11-14T00:00:00.000Z");
      expect(a.items.map((i) => [i.kind, i.taskId])).toEqual([
        ["run", "a"],
        ["occurrence", "b"],
        ["occurrence", "c"],
      ]);
    }
  });

  it("past the first day's safety caps nothing is returned and horizon is from", () => {
    const tasks = ["a", "b", "c"].map((id) => task(id));
    const from = new Date("2026-11-13T00:00:00Z");
    const range = { tasks, from, to: new Date("2026-11-20T00:00:00Z") };
    const ticks = assembleCalendar(input(range), { ...CALENDAR_LIMITS, firstDayTickCap: 2 });
    expect(ticks).toMatchObject({ items: [], collapsed: [], tasks: [], truncated: true });
    expect(ticks.horizon).toBe(from.toISOString());
    const runs = assembleCalendar(
      input({
        ...range,
        runs: [run("a", "2026-11-13T01:00:00Z"), run("a", "2026-11-13T02:00:00Z")],
      }),
      { ...CALENDAR_LIMITS, firstDayRunCap: 1 },
    );
    expect(runs).toMatchObject({ items: [], collapsed: [], truncated: true });
    expect(runs.horizon).toBe(from.toISOString());
  });

  it("horizon is never before from", () => {
    const a = assembleCalendar(
      input({
        tasks: [task("daily")],
        from: new Date("2027-01-01T00:00:00Z"),
        to: new Date("2027-01-08T00:00:00Z"),
      }),
    );
    expect(a.items).toEqual([]);
    expect(a.horizon).toBe("2027-01-01T00:00:00.000Z");
  });

  it("orders items by scheduledFor, then taskId", () => {
    const a = assembleCalendar(
      input({ tasks: [task("b"), task("a"), task("c", { trigger: cron("30 8 * * *") })] }),
    );
    const firstDay = a.items.filter((i) => i.scheduledFor.startsWith("2026-11-12"));
    expect(firstDay.map((i) => [i.scheduledFor.slice(11, 16), i.taskId])).toEqual([
      ["08:30", "c"],
      ["09:00", "a"],
      ["09:00", "b"],
    ]);
  });
});

describe("local days", () => {
  it("dayKey and startOfLocalDay across a DST change", () => {
    // New York falls back on 2026-11-01: that day is 25 hours long
    const tz = "America/New_York";
    expect(dayKey(Date.parse("2026-11-01T04:00:00Z"), tz)).toBe("2026-11-01");
    expect(dayKey(Date.parse("2026-11-01T03:59:59Z"), tz)).toBe("2026-10-31");
    expect(new Date(startOfLocalDay(Date.parse("2026-11-01T20:00:00Z"), tz)).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(new Date(startOfLocalDay(Date.parse("2026-11-02T04:59:00Z"), tz)).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(new Date(startOfLocalDay(Date.parse("2026-11-02T05:00:00Z"), tz)).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
});
