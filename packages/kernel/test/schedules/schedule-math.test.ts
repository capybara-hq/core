import { CronTime } from "cron";
import { describe, expect, it, vi } from "vitest";
import {
  dueTicks,
  jitterForGap,
  jitterSeconds,
  minGapMinutes,
  nextTick,
  scanStep,
  ticksIn,
  validateTrigger,
} from "../../src/schedules/schedule-math.js";
import type { ScheduleTrigger } from "../../src/schedules/types.js";

const cron = (expr: string, timeZone = "UTC"): ScheduleTrigger => ({
  kind: "cron",
  expr,
  timeZone,
});
const now = new Date("2026-06-01T00:00:00Z");

describe("schedule math", () => {
  it("rejects a 6-field expression", () => {
    expect(validateTrigger(cron("0 0 9 * * *"), now)).toEqual({
      ok: false,
      code: "schedule.invalid_cron",
    });
    expect(validateTrigger(cron("nonsense"), now)).toEqual({
      ok: false,
      code: "schedule.invalid_cron",
    });
    expect(validateTrigger(cron("0 9 * * *"), now)).toEqual({ ok: true });
  });

  it("rejects an unknown zone", () => {
    expect(validateTrigger(cron("0 9 * * *", "Mars/Base"), now)).toEqual({
      ok: false,
      code: "schedule.invalid_time_zone",
    });
  });

  it("rejects a once task in the past and accepts a future one", () => {
    const once = (at: string): ScheduleTrigger => ({ kind: "once", at, timeZone: "Asia/Shanghai" });
    expect(validateTrigger(once("2026-05-31T09:00:00"), now)).toEqual({
      ok: false,
      code: "schedule.once_in_past",
    });
    expect(validateTrigger(once("2026-06-02T09:00:00"), now)).toEqual({ ok: true });
    expect(nextTick(once("2026-06-02T09:00:00"), now)?.toISOString()).toBe(
      "2026-06-02T01:00:00.000Z",
    );
    expect(nextTick(once("2026-05-31T09:00:00"), now)).toBeNull();
    expect(minGapMinutes(once("2026-06-02T09:00:00"), now)).toBeNull();
  });

  it("0 9 * * * in Asia/Shanghai is 01:00Z", () => {
    expect(nextTick(cron("0 9 * * *", "Asia/Shanghai"), now)?.toISOString()).toBe(
      "2026-06-01T01:00:00.000Z",
    );
  });

  it("dst gaps and repeats", () => {
    const ny = cron("30 2 * * *", "America/New_York");
    // 2026-03-08: 02:00-03:00 does not exist in New York.
    const gap = dueTicks(
      ny,
      new Date("2026-03-08T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z"),
      100000,
    );
    expect(gap).toEqual({ fire: null, firstMissed: null });
    // 2026-11-01: 01:00-02:00 happens twice.
    const rep = dueTicks(
      cron("30 1 * * *", "America/New_York"),
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
      100000,
    );
    expect(rep.firstMissed).toBeNull();
    expect(rep.fire?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("minGapMinutes of */15 is 15", () => {
    expect(minGapMinutes(cron("*/15 * * * *"), now)).toBe(15);
    expect(minGapMinutes(cron("0 9 * * *"), now)).toBe(1440);
    expect(minGapMinutes(cron("0,5 9 * * *"), now)).toBe(5);
  });

  it("jitter is stable per id and <= 300 s and <= 10 % of the interval", () => {
    // sample each gap once; the per-id properties use jitterForGap (no 50-tick walk per id)
    const daily = cron("0 9 * * *");
    const dailyGap = minGapMinutes(daily, now);
    expect(dailyGap).toBe(1440);
    const every5 = cron("*/5 * * * *");
    const every5Gap = minGapMinutes(every5, now);
    expect(every5Gap).toBe(5);
    // end to end: jitterSeconds is jitterForGap of the sampled gap
    expect(jitterSeconds("task-a", daily, now)).toBe(jitterForGap("task-a", dailyGap));
    expect(jitterSeconds("t0", every5, now)).toBe(jitterForGap("t0", every5Gap));
    expect(jitterForGap("task-a", dailyGap)).toBe(jitterForGap("task-a", dailyGap));
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const j = jitterForGap(`task-${i}`, dailyGap);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(300);
      seen.add(j);
    }
    expect(seen.size).toBeGreaterThan(1);
    for (let i = 0; i < 50; i++) expect(jitterForGap(`t${i}`, every5Gap)).toBeLessThan(30);
    expect(
      jitterSeconds("x", { kind: "once", at: "2026-06-02T09:00:00", timeZone: "UTC" }, now),
    ).toBe(0);
    expect(jitterForGap("x", null)).toBe(0);
  });

  it("dueTicks after a 3 h outage on an hourly task fires the latest and reports the first missed", () => {
    const r = dueTicks(
      cron("0 * * * *"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T03:10:00Z"),
      60,
    );
    expect(r.fire?.toISOString()).toBe("2026-06-01T03:00:00.000Z");
    expect(r.firstMissed?.toISOString()).toBe("2026-06-01T01:00:00.000Z");
  });

  it("dueTicks drops a tick older than the window", () => {
    const r = dueTicks(
      cron("0 * * * *"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T01:50:00Z"),
      30,
    );
    expect(r.fire).toBeNull();
    expect(r.firstMissed).toEqual(new Date("2026-06-01T01:00:00.000Z"));
  });

  it("dueTicks after a 30 day outage on */5 still fires the latest in-window tick", () => {
    const n = new Date("2026-06-30T12:03:00Z");
    const calls = vi.spyOn(CronTime.prototype, "getNextDateFrom");
    let r: ReturnType<typeof dueTicks>;
    try {
      r = dueTicks(cron("*/5 * * * *"), new Date("2026-05-31T12:00:00Z"), n, 60);
      // no walk over the ~8600 old ticks: a handful of tick computations
      expect(calls.mock.calls.length).toBeLessThan(30);
    } finally {
      calls.mockRestore();
    }
    expect(r.fire?.toISOString()).toBe("2026-06-30T12:00:00.000Z");
    expect(r.firstMissed).toEqual(new Date("2026-05-31T12:05:00.000Z"));
  });

  it("dueTicks: no tick due, and a once task due inside and outside the window", () => {
    const r = dueTicks(cron("0 9 * * *"), new Date("2026-06-01T09:00:00Z"), now, 60);
    expect(r).toEqual({ fire: null, firstMissed: null });
    const once: ScheduleTrigger = { kind: "once", at: "2026-06-01T08:30:00", timeZone: "UTC" };
    const lastTick = new Date("2026-06-01T08:29:59Z");
    expect(dueTicks(once, lastTick, new Date("2026-06-01T09:00:00Z"), 60)).toEqual({
      fire: new Date("2026-06-01T08:30:00Z"),
      firstMissed: null,
    });
    expect(dueTicks(once, lastTick, new Date("2026-06-01T10:00:00Z"), 60)).toEqual({
      fire: null,
      firstMissed: new Date("2026-06-01T08:30:00Z"),
    });
  });

  it("a once time inside a DST gap fires at the first instant after the gap", () => {
    const once: ScheduleTrigger = {
      kind: "once",
      at: "2026-03-08T02:30:00",
      timeZone: "America/New_York",
    };
    expect(nextTick(once, new Date("2026-03-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(validateTrigger(once, new Date("2026-03-01T00:00:00Z"))).toEqual({ ok: true });
  });

  it("rejects a malformed once time as invalid_once_time", () => {
    for (const at of [
      "2026-13-45T25:61:00",
      "2026-02-30T10:00:00",
      "tomorrow",
      "2026-06-02T09:00:00Z",
    ]) {
      expect(validateTrigger({ kind: "once", at, timeZone: "UTC" }, now)).toEqual({
        ok: false,
        code: "schedule.invalid_once_time",
      });
    }
  });
});

const MIN = 60_000;
const HOUR = 3_600_000;

/** Every tick in (after, until] by repeated nextTick. */
function byNextTick(t: ScheduleTrigger, after: Date, until: Date): Date[] {
  const out: Date[] = [];
  for (let tick = nextTick(t, after); tick && tick <= until; tick = nextTick(t, tick)) {
    out.push(tick);
  }
  return out;
}

const iso = (ds: readonly Date[]) => ds.map((d) => d.toISOString());

describe("ticksIn", () => {
  it("equals repeated nextTick, in (after, until]", () => {
    for (const t of [
      cron("0 9 * * *", "Asia/Shanghai"),
      cron("0 * * * *", "America/New_York"),
      cron("*/15 * * * *", "Europe/London"),
      cron("0 9 * * 1", "America/New_York"),
    ]) {
      const after = new Date("2026-03-01T00:00:00Z");
      const until = new Date("2026-03-12T00:00:00Z");
      const r = ticksIn(t, after, until, 100_000);
      expect(r.exhausted).toBe(false);
      expect(iso(r.ticks)).toEqual(iso(byNextTick(t, after, until)));
    }
    // a tick exactly at `after` is out, one exactly at `until` is in
    const daily = cron("0 9 * * *");
    expect(
      iso(
        ticksIn(daily, new Date("2026-06-01T09:00:00Z"), new Date("2026-06-03T09:00:00Z"), 10)
          .ticks,
      ),
    ).toEqual(["2026-06-02T09:00:00.000Z", "2026-06-03T09:00:00.000Z"]);
  });

  it("stops at max and says so", () => {
    const hourly = cron("0 * * * *");
    const after = new Date("2026-06-01T00:00:00Z");
    const r = ticksIn(hourly, after, new Date("2026-06-02T00:00:00Z"), 5);
    expect(r.exhausted).toBe(true);
    expect(r.ticks).toHaveLength(5);
    expect(ticksIn(hourly, after, new Date("2026-06-01T03:00:00Z"), 5)).toMatchObject({
      exhausted: false,
    });
    expect(ticksIn(hourly, after, after, 5)).toEqual({ ticks: [], exhausted: false });
  });

  it("a once trigger yields its tick only inside the window", () => {
    const once: ScheduleTrigger = { kind: "once", at: "2026-06-02T09:00:00", timeZone: "UTC" };
    expect(iso(ticksIn(once, now, new Date("2026-06-03T00:00:00Z"), 10).ticks)).toEqual([
      "2026-06-02T09:00:00.000Z",
    ]);
    expect(ticksIn(once, now, new Date("2026-06-02T08:59:59Z"), 10).ticks).toEqual([]);
    expect(
      ticksIn(once, new Date("2026-06-02T09:00:00Z"), new Date("2026-06-03T00:00:00Z"), 10).ticks,
    ).toEqual([]);
  });
});

interface SimTask {
  trigger: ScheduleTrigger;
  jitterSeconds: number;
  expiresAt?: Date;
}

/**
 * The scanner over [start, end] (scan.job.ts: a task is due when next_run_at <= now, then
 * scanStep, as `advance` applies it), for a task created at `start` (next_run_at = the first tick
 * after it plus jitter, as the service creates it). `scanAt` lists the scan instants: every minute
 * (plus a delay) or a jump to each next_run_at. Returns the fired and the missed ticks.
 */
function simulateScanner(
  task: SimTask,
  start: Date,
  end: Date,
  scanAt: "minutes" | "jumps",
  delaySeconds: number,
): { fired: Date[]; missed: Date[] } {
  const fired: Date[] = [];
  const missed: Date[] = [];
  const first = nextTick(task.trigger, start);
  let nextRunAt = first === null ? null : new Date(first.getTime() + task.jitterSeconds * 1000);
  const expires = task.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (first !== null && first.getTime() > expires) nextRunAt = null;
  let now = new Date(Math.ceil(start.getTime() / MIN) * MIN + delaySeconds * 1000);
  while (nextRunAt !== null && now <= end) {
    if (nextRunAt <= now) {
      const step = scanStep(
        {
          trigger: task.trigger,
          nextRunAt,
          jitterSeconds: task.jitterSeconds,
          expiresAt: task.expiresAt ?? null,
        },
        now,
        60,
      );
      if (step.missed) missed.push(step.missed);
      if (step.fire) fired.push(step.fire);
      nextRunAt = step.nextRunAt;
    }
    if (scanAt === "minutes" || nextRunAt === null) {
      now = new Date(now.getTime() + MIN);
    } else {
      // the first minute at or after next_run_at, plus the delay
      const at = Math.ceil(nextRunAt.getTime() / MIN) * MIN + delaySeconds * 1000;
      now = new Date(Math.max(at, now.getTime() + MIN));
    }
  }
  return { fired, missed };
}

/** The ticks the calendar plans for a task created at `start`: ticksIn up to `until`. */
function planned(task: SimTask, start: Date, until: Date): Date[] {
  const bound = task.expiresAt && task.expiresAt < until ? task.expiresAt : until;
  return ticksIn(task.trigger, start, bound, 100_000).ticks;
}

describe("scanner parity: ticksIn lists exactly what the scanner fires", () => {
  const cases: { name: string; task: SimTask; start: string }[] = [
    {
      name: "daily 09:00 Shanghai",
      task: { trigger: cron("0 9 * * *", "Asia/Shanghai"), jitterSeconds: 137 },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "hourly Shanghai",
      task: { trigger: cron("0 * * * *", "Asia/Shanghai"), jitterSeconds: 211 },
      start: "2026-10-20T00:00:00Z",
    },
    {
      name: "daily 09:00 New York, spring",
      task: { trigger: cron("0 9 * * *", "America/New_York"), jitterSeconds: 137 },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "daily 02:30 New York, spring",
      task: { trigger: cron("30 2 * * *", "America/New_York"), jitterSeconds: 42 },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "hourly New York, spring",
      task: { trigger: cron("0 * * * *", "America/New_York"), jitterSeconds: 211 },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "daily 01:30 New York, fall",
      task: { trigger: cron("30 1 * * *", "America/New_York"), jitterSeconds: 299 },
      start: "2026-10-27T00:00:00Z",
    },
    {
      name: "hourly New York, fall",
      task: { trigger: cron("0 * * * *", "America/New_York"), jitterSeconds: 211 },
      start: "2026-10-27T00:00:00Z",
    },
    {
      name: "daily 01:30 London, spring",
      task: { trigger: cron("30 1 * * *", "Europe/London"), jitterSeconds: 137 },
      start: "2026-03-24T00:00:00Z",
    },
    {
      name: "hourly London, spring",
      task: { trigger: cron("0 * * * *", "Europe/London"), jitterSeconds: 211 },
      start: "2026-03-24T00:00:00Z",
    },
    {
      name: "daily 01:30 London, fall",
      task: { trigger: cron("30 1 * * *", "Europe/London"), jitterSeconds: 137 },
      start: "2026-10-20T00:00:00Z",
    },
    {
      name: "hourly London, fall",
      task: { trigger: cron("0 * * * *", "Europe/London"), jitterSeconds: 211 },
      start: "2026-10-20T00:00:00Z",
    },
    {
      name: "weekly Monday 09:00 New York, spring",
      task: { trigger: cron("0 9 * * 1", "America/New_York"), jitterSeconds: 250 },
      start: "2026-03-01T00:00:00Z",
    },
    {
      name: "*/15 London, fall",
      task: { trigger: cron("*/15 * * * *", "Europe/London"), jitterSeconds: 53 },
      start: "2026-10-20T00:00:00Z",
    },
    {
      name: "*/15 New York, spring",
      task: { trigger: cron("*/15 * * * *", "America/New_York"), jitterSeconds: 53 },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "once in the New York gap",
      task: {
        trigger: { kind: "once", at: "2026-03-08T02:30:00", timeZone: "America/New_York" },
        jitterSeconds: 0,
      },
      start: "2026-03-03T00:00:00Z",
    },
    {
      name: "hourly New York, expiring mid-window",
      task: {
        trigger: cron("0 * * * *", "America/New_York"),
        jitterSeconds: 211,
        expiresAt: new Date("2026-03-09T12:00:00Z"),
      },
      start: "2026-03-03T00:00:00Z",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const start = new Date(c.start);
      const end = new Date(start.getTime() + 10 * 24 * HOUR);
      // a tick in the last minutes of the window fires after it: compare up to a bound the scanner
      // has surely passed
      const until = new Date(end.getTime() - c.task.jitterSeconds * 1000 - 2 * MIN);
      const plan = planned(c.task, start, until);
      expect(plan.length).toBeGreaterThan(0);
      // every minute on the dot, every minute late, and straight to each next_run_at
      const scans = [
        ["minutes", 0],
        ["minutes", 59],
        ["jumps", 7],
      ] as const;
      for (const [scanAt, delay] of scans) {
        const sim = simulateScanner(c.task, start, end, scanAt, delay);
        expect(sim.missed, `${scanAt} +${delay}s missed`).toEqual([]);
        expect(iso(sim.fired.filter((d) => d <= until)), `${scanAt} +${delay}s`).toEqual(iso(plan));
      }
      // the tick evaluations are slow (cron walks a calendar): a 10-day window of */15 takes seconds
    });
  }

  it("02:30 New York does not fire on the spring-forward day, 01:30 fires once on the fall-back day", () => {
    const spring = planned(
      { trigger: cron("30 2 * * *", "America/New_York"), jitterSeconds: 0 },
      new Date("2026-03-07T12:00:00Z"),
      new Date("2026-03-09T12:00:00Z"),
    );
    expect(iso(spring)).toEqual(["2026-03-09T06:30:00.000Z"]);
    const fall = planned(
      { trigger: cron("30 1 * * *", "America/New_York"), jitterSeconds: 0 },
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
    );
    expect(iso(fall)).toEqual(["2026-11-01T05:30:00.000Z"]);
  });

  it("once in a gap fires at the first instant after it", () => {
    const once = planned(
      {
        trigger: { kind: "once", at: "2026-03-08T02:30:00", timeZone: "America/New_York" },
        jitterSeconds: 0,
      },
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-20T00:00:00Z"),
    );
    expect(iso(once)).toEqual(["2026-03-08T07:00:00.000Z"]);
  });

  it("an expiring task fires nothing after expires_at and ends", () => {
    const task: SimTask = {
      trigger: cron("0 * * * *", "UTC"),
      jitterSeconds: 0,
      expiresAt: new Date("2026-06-01T05:00:00Z"),
    };
    const sim = simulateScanner(
      task,
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z"),
      "minutes",
      0,
    );
    expect(iso(sim.fired).at(-1)).toBe("2026-06-01T05:00:00.000Z");
    expect(sim.fired).toHaveLength(5);
  });
});
