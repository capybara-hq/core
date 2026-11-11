import { describe, expect, it } from "vitest";
import {
  dateIn,
  endOfDayIn,
  presetOf,
  presetValid,
  type SchedulePreset,
  scheduleWords,
  splitToolKeys,
  switchPreset,
  triggerOf,
} from "../src/lib/schedules";

describe("schedule presets write cron (scheduled tasks spec §5)", () => {
  const cases: [SchedulePreset, string][] = [
    [{ kind: "hourly", minute: 15 }, "15 * * * *"],
    [{ kind: "daily", time: "09:00" }, "0 9 * * *"],
    [{ kind: "weekdays", time: "18:30" }, "30 18 * * 1-5"],
    [{ kind: "weekly", day: 1, time: "08:05" }, "5 8 * * 1"],
    [{ kind: "monthly", day: 28, time: "00:00" }, "0 0 28 * *"],
  ];

  it.each(cases)("%j → %s, and back", (preset, expr) => {
    expect(triggerOf(preset)).toEqual({ kind: "cron", expr });
    expect(presetOf({ kind: "cron", expr })).toEqual(preset);
  });

  it("anything else is custom; once keeps its local time", () => {
    expect(presetOf({ kind: "cron", expr: "*/5 9-17 * * 1-5" })).toEqual({
      kind: "custom",
      expr: "*/5 9-17 * * 1-5",
    });
    expect(presetOf({ kind: "cron", expr: "0 9 * * 7" })).toEqual({
      kind: "weekly",
      day: 0,
      time: "09:00",
    });
    expect(triggerOf({ kind: "once", at: "2026-12-01T09:00" })).toEqual({
      kind: "once",
      at: "2026-12-01T09:00",
    });
    expect(presetValid({ kind: "once", at: "" })).toBe(false);
    expect(presetValid({ kind: "custom", expr: "0 9 * *" })).toBe(false);
  });

  it("switching presets keeps the time; custom starts from the current cron", () => {
    const daily: SchedulePreset = { kind: "daily", time: "07:45" };
    expect(switchPreset(daily, "weekdays")).toEqual({ kind: "weekdays", time: "07:45" });
    expect(switchPreset(daily, "custom")).toEqual({ kind: "custom", expr: "45 7 * * *" });
  });

  it("words: the message key and its values", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 9 * * 1-5" })).toEqual({
      key: "weekdays",
      values: { time: "09:00" },
    });
    expect(scheduleWords({ kind: "once", at: "2026-12-01T09:00" })).toEqual({
      key: "once",
      values: { at: "2026-12-01 09:00" },
    });
  });
});

describe("presets the selects can't show read as custom", () => {
  it("a monthly day past 28 or an hourly minute not offered", () => {
    expect(presetOf({ kind: "cron", expr: "0 9 31 * *" })).toEqual({
      kind: "custom",
      expr: "0 9 31 * *",
    });
    expect(presetOf({ kind: "cron", expr: "7 * * * *" })).toEqual({
      kind: "custom",
      expr: "7 * * * *",
    });
    expect(presetOf({ kind: "cron", expr: "0 9 28 * *" })).toMatchObject({ kind: "monthly" });
  });
});

describe("helpers", () => {
  it("splitToolKeys: one per line, commas and spaces too, no repeats", () => {
    expect(splitToolKeys("Bash\n mcp__gh__create_issue, Bash\n\n")).toEqual([
      "Bash",
      "mcp__gh__create_issue",
    ]);
  });

  it("an end date is the end of that day in the task's zone", () => {
    expect(endOfDayIn("2026-12-31", "UTC")).toBe("2026-12-31T23:59:59.000Z");
    expect(endOfDayIn("2026-12-31", "Asia/Shanghai")).toBe("2026-12-31T15:59:59.000Z");
    expect(dateIn("2026-12-31T15:59:59.000Z", "Asia/Shanghai")).toBe("2026-12-31");
  });
});
