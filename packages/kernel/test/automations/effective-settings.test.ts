import { describe, expect, it } from "vitest";
import { parseOrgSettings } from "../../src/orgs/settings.service.js";
import {
  effectiveScheduleSettings,
  type ScheduleBounds,
} from "../../src/schedules/effective-settings.js";

const bounds: ScheduleBounds = {
  minIntervalFloorMinutes: 5,
  maxTasksPerMemberCap: 100,
  maxTasksPerOrgCap: 2000,
  maxRunsPerHourCap: 600,
};

describe("scheduled task settings", () => {
  it("defaults match spec §9", () => {
    expect(parseOrgSettings({}).scheduledTasks).toEqual({
      enabled: true,
      minIntervalMinutes: 60,
      maxTasksPerMember: 20,
      maxTasksPerOrg: 200,
      maxRunsPerHour: 60,
      defaultExpiryDays: null,
      catchUpWindowMinutes: 60,
      unattendedAsk: "fail",
      pauseAfterFailures: 5,
      forbiddenTools: [],
    });
  });

  it("minInterval below the floor is clamped to 5", () => {
    const org = parseOrgSettings({ scheduledTasks: { minIntervalMinutes: 1 } }).scheduledTasks;
    expect(effectiveScheduleSettings(org, bounds).minIntervalMinutes).toBe(5);
  });

  it("counts above the caps are clamped", () => {
    const org = parseOrgSettings({
      scheduledTasks: { maxTasksPerMember: 5000, maxTasksPerOrg: 99999, maxRunsPerHour: 100000 },
    }).scheduledTasks;
    const eff = effectiveScheduleSettings(org, bounds);
    expect(eff).toMatchObject({
      maxTasksPerMember: 100,
      maxTasksPerOrg: 2000,
      maxRunsPerHour: 600,
    });
  });

  it("an invalid stored value falls back to the default", () => {
    const org = parseOrgSettings({
      scheduledTasks: {
        enabled: "yes",
        maxTasksPerOrg: -3,
        unattendedAsk: "x",
        forbiddenTools: 7,
        maxRunsPerHour: 10,
      },
    }).scheduledTasks;
    expect(org).toMatchObject({
      enabled: true,
      maxTasksPerOrg: 200,
      unattendedAsk: "fail",
      forbiddenTools: [],
      maxRunsPerHour: 10,
    });
    expect(parseOrgSettings({ scheduledTasks: "junk" }).scheduledTasks.minIntervalMinutes).toBe(60);
  });

  it("an invalid forbiddenTools entry is dropped, the valid ones stay (fail-safe)", () => {
    const org = parseOrgSettings({
      scheduledTasks: { forbiddenTools: ["Bash", 7, "", "x".repeat(201), null, "WebFetch"] },
    }).scheduledTasks;
    expect(org.forbiddenTools).toEqual(["Bash", "WebFetch"]);
  });

  it("a stored forbiddenTools list past 500 is truncated, not reset", () => {
    const keys = Array.from({ length: 600 }, (_, i) => `Tool${i}`);
    const org = parseOrgSettings({ scheduledTasks: { forbiddenTools: keys } }).scheduledTasks;
    expect(org.forbiddenTools).toEqual(keys.slice(0, 500));
  });
});
