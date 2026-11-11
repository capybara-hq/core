import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  presetOf,
  presetValid,
  type SchedulePreset,
  scheduleWords,
  startedByTask,
  switchPreset,
  triggerOf,
} from "../src/lib/schedules";

const ev = (seq: number, type: string, payload: unknown): ConversationEvent =>
  ({ conversationId: "c1", seq, type, payload, runId: null, createdAt: "" }) as ConversationEvent;
const userMsg = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1", ...extra });

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

describe("startedByTask", () => {
  const marker = { taskId: "s1", taskName: "Daily report", trial: false };

  it("the first message's marker names the task", () => {
    expect(startedByTask([userMsg(1, "go", { schedule: marker })])).toEqual({
      taskId: "s1",
      name: "Daily report",
    });
  });

  it("null for a person's first message, or when the log's start is not loaded", () => {
    expect(startedByTask([userMsg(1, "hi"), userMsg(2, "go", { schedule: marker })])).toBeNull();
    expect(startedByTask([userMsg(5, "go", { schedule: marker })])).toBeNull();
    expect(startedByTask([ev(1, "run_started", {})])).toBeNull();
  });
});
