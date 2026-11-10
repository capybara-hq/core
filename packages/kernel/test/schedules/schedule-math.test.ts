import { describe, expect, it } from "vitest";
import {
  dueTicks,
  jitterForGap,
  jitterSeconds,
  minGapMinutes,
  nextTick,
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
    expect([gap.fire, ...gap.missed].filter(Boolean)).toHaveLength(0);
    // 2026-11-01: 01:00-02:00 happens twice.
    const rep = dueTicks(
      cron("30 1 * * *", "America/New_York"),
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
      100000,
    );
    expect([rep.fire, ...rep.missed].filter(Boolean)).toHaveLength(1);
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

  it("dueTicks after a 3 h outage on an hourly task fires the latest and reports 2 missed", () => {
    const r = dueTicks(
      cron("0 * * * *"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T03:10:00Z"),
      60,
    );
    expect(r.fire?.toISOString()).toBe("2026-06-01T03:00:00.000Z");
    expect(r.missed.map((d) => d.toISOString())).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-01T02:00:00.000Z",
    ]);
  });

  it("dueTicks drops a tick older than the window", () => {
    const r = dueTicks(
      cron("0 * * * *"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T01:50:00Z"),
      30,
    );
    expect(r.fire).toBeNull();
    expect(r.missed.map((d) => d.toISOString())).toEqual(["2026-06-01T01:00:00.000Z"]);
  });

  it("dueTicks after a 30 day outage on */5 still fires the latest in-window tick", () => {
    const n = new Date("2026-06-30T12:03:00Z");
    const r = dueTicks(cron("*/5 * * * *"), new Date("2026-05-31T12:00:00Z"), n, 60);
    expect(r.fire?.toISOString()).toBe("2026-06-30T12:00:00.000Z");
    expect(r.missed.length).toBeGreaterThan(0);
    const fireMs = r.fire?.getTime() ?? 0;
    expect(r.missed.every((d) => d.getTime() < fireMs)).toBe(true);
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
