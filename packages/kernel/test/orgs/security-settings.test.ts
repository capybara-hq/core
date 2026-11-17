import { describe, expect, it } from "vitest";
import {
  invalidStoredForbiddenTools,
  invalidStoredSandboxToolPolicy,
  logUnreadableSecuritySettings,
  parseOrgSettings,
} from "../../src/orgs/settings.service.js";
import { effectiveScheduleSettings } from "../../src/schedules/effective-settings.js";

/**
 * Org security settings read narrow (design review 2026-11-16, org-settings-heal-on-read): an
 * unreadable `sandboxToolPolicy` reads as `ask`, an unreadable `forbiddenTools` is flagged so
 * unattended runs fail, and both are logged with the org id.
 */

const warnings = () => {
  const out: Array<[string, unknown]> = [];
  return { out, log: (msg: string, ctx: unknown) => void out.push([msg, ctx]) };
};

describe("sandboxToolPolicy", () => {
  it("absent reads as allow; a stored valid value is kept", () => {
    expect(parseOrgSettings({}).sandboxToolPolicy).toBe("allow");
    expect(parseOrgSettings({ sandboxToolPolicy: "allow" }).sandboxToolPolicy).toBe("allow");
    expect(parseOrgSettings({ sandboxToolPolicy: "ask" }).sandboxToolPolicy).toBe("ask");
    expect(invalidStoredSandboxToolPolicy({})).toBe(false);
    expect(invalidStoredSandboxToolPolicy({ sandboxToolPolicy: "ask" })).toBe(false);
  });

  it.each([["deny"], ["ALLOW"], [7], [null], [true], [["allow"]], [{}]])(
    "a corrupt stored value %j reads as ask and is flagged",
    (v) => {
      expect(parseOrgSettings({ sandboxToolPolicy: v }).sandboxToolPolicy).toBe("ask");
      expect(invalidStoredSandboxToolPolicy({ sandboxToolPolicy: v })).toBe(true);
    },
  );
});

describe("forbiddenTools", () => {
  it("absent, a list, or a list with bad entries is readable", () => {
    expect(invalidStoredForbiddenTools({})).toBe(false);
    expect(invalidStoredForbiddenTools(null)).toBe(false);
    expect(invalidStoredForbiddenTools({ scheduledTasks: {} })).toBe(false);
    expect(invalidStoredForbiddenTools({ scheduledTasks: { forbiddenTools: [] } })).toBe(false);
    expect(
      invalidStoredForbiddenTools({ scheduledTasks: { forbiddenTools: ["Bash", 7, null] } }),
    ).toBe(false);
  });

  it.each([[7], ["Bash"], [null], [{ Bash: true }], [true]])(
    "a stored non-list %j is unreadable (display reads [])",
    (v) => {
      const raw = { scheduledTasks: { forbiddenTools: v } };
      expect(invalidStoredForbiddenTools(raw)).toBe(true);
      expect(parseOrgSettings(raw).scheduledTasks.forbiddenTools).toEqual([]);
    },
  );

  it.each([["junk"], [7], [null], [["Bash"]]])(
    "a stored scheduledTasks group %j that is not an object is unreadable",
    (v) => {
      expect(invalidStoredForbiddenTools({ scheduledTasks: v })).toBe(true);
    },
  );

  it("the effective settings carry the flag", () => {
    const bounds = {
      minIntervalFloorMinutes: 5,
      maxTasksPerMemberCap: 100,
      maxTasksPerOrgCap: 2000,
      maxRunsPerHourCap: 600,
    };
    const org = parseOrgSettings({}).scheduledTasks;
    expect(effectiveScheduleSettings(org, bounds).forbiddenToolsUnreadable).toBe(false);
    expect(effectiveScheduleSettings(org, bounds, true).forbiddenToolsUnreadable).toBe(true);
  });
});

describe("logUnreadableSecuritySettings", () => {
  it("logs each unreadable value with the org id", () => {
    const { out, log } = warnings();
    logUnreadableSecuritySettings(log, "org-1", {
      sandboxToolPolicy: "deny",
      scheduledTasks: { forbiddenTools: "Bash" },
    });
    expect(out).toEqual([
      [expect.stringContaining("sandboxToolPolicy"), { orgId: "org-1" }],
      [expect.stringContaining("forbiddenTools"), { orgId: "org-1" }],
    ]);
  });

  it("logs nothing for readable values", () => {
    const { out, log } = warnings();
    logUnreadableSecuritySettings(log, "org-1", {
      sandboxToolPolicy: "allow",
      scheduledTasks: { forbiddenTools: ["Bash"] },
    });
    expect(out).toEqual([]);
  });
});
