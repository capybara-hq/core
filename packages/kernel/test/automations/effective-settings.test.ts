import { describe, expect, it } from "vitest";
import {
  type AutomationBounds,
  effectiveAutomationSettings,
} from "../../src/automations/effective-settings.js";
import { parseOrgSettings } from "../../src/orgs/settings.service.js";

const bounds: AutomationBounds = {
  minIntervalFloorMinutes: 5,
  maxTasksPerMemberCap: 100,
  maxTasksPerOrgCap: 2000,
  maxRunsPerHourCap: 600,
  maxEventDepthCap: 16,
  coalesceSecondsCap: 3600,
  maxEventRunsPerSubjectPerHourCap: 120,
};

describe("automation settings", () => {
  it("defaults match spec §9", () => {
    expect(parseOrgSettings({}).automations).toEqual({
      enabled: true,
      minIntervalMinutes: 60,
      maxTasksPerMember: 20,
      maxTasksPerOrg: 200,
      maxRunsPerHour: 60,
      defaultExpiryDays: null,
      catchUpWindowMinutes: 60,
      unattendedAsk: "fail",
      pauseAfterFailures: 5,
      maxEventDepth: 8,
      coalesceSeconds: 30,
      maxEventRunsPerSubjectPerHour: 12,
      directedDefault: "auto",
      eventSourcesOff: [],
      forbiddenTools: [],
    });
  });

  it("minInterval below the floor is clamped to 5", () => {
    const org = parseOrgSettings({ automations: { minIntervalMinutes: 1 } }).automations;
    expect(effectiveAutomationSettings(org, bounds).minIntervalMinutes).toBe(5);
  });

  it("counts above the caps are clamped", () => {
    const org = parseOrgSettings({
      automations: { maxTasksPerMember: 5000, maxTasksPerOrg: 99999, maxRunsPerHour: 100000 },
    }).automations;
    const eff = effectiveAutomationSettings(org, bounds);
    expect(eff).toMatchObject({
      maxTasksPerMember: 100,
      maxTasksPerOrg: 2000,
      maxRunsPerHour: 600,
    });
  });

  it("the event settings above the caps are clamped", () => {
    const org = parseOrgSettings({
      automations: { maxEventDepth: 50, coalesceSeconds: 7200, maxEventRunsPerSubjectPerHour: 500 },
    }).automations;
    expect(effectiveAutomationSettings(org, bounds)).toMatchObject({
      maxEventDepth: 16,
      coalesceSeconds: 3600,
      maxEventRunsPerSubjectPerHour: 120,
    });
  });

  it("an invalid eventSourcesOff entry is dropped, the valid ones stay off", () => {
    const org = parseOrgSettings({
      automations: { eventSourcesOff: ["tracker", 7, "", "x".repeat(215), "docs"] },
    }).automations;
    expect(org.eventSourcesOff).toEqual(["tracker", "docs"]);
    expect(
      parseOrgSettings({ automations: { eventSourcesOff: "x" } }).automations.eventSourcesOff,
    ).toEqual([]);
  });

  it("an invalid stored value falls back to the default", () => {
    const org = parseOrgSettings({
      automations: {
        enabled: "yes",
        maxTasksPerOrg: -3,
        unattendedAsk: "x",
        forbiddenTools: 7,
        maxRunsPerHour: 10,
      },
    }).automations;
    expect(org).toMatchObject({
      enabled: true,
      maxTasksPerOrg: 200,
      unattendedAsk: "fail",
      forbiddenTools: [],
      maxRunsPerHour: 10,
    });
    expect(parseOrgSettings({ automations: "junk" }).automations.minIntervalMinutes).toBe(60);
  });

  it("an invalid forbiddenTools entry is dropped, the valid ones stay (fail-safe)", () => {
    const org = parseOrgSettings({
      automations: { forbiddenTools: ["Bash", 7, "", "x".repeat(201), null, "WebFetch"] },
    }).automations;
    expect(org.forbiddenTools).toEqual(["Bash", "WebFetch"]);
  });

  it("a stored forbiddenTools list past 500 is truncated, not reset", () => {
    const keys = Array.from({ length: 600 }, (_, i) => `Tool${i}`);
    const org = parseOrgSettings({ automations: { forbiddenTools: keys } }).automations;
    expect(org.forbiddenTools).toEqual(keys.slice(0, 500));
  });
});
