import { describe, expect, it } from "vitest";
import type { EventPayload } from "../../src/conversations/events.js";
import {
  invocableSource,
  projectInvocables,
  projectSkillBlocked,
} from "../../src/skills/invoke.js";

/**
 * Project root spec §4.6: the `/` menu's entries carry their `source`, a bound conversation's
 * latest usable `project_root` adds its skills as `project:<name>`. A person's invocation of one
 * is the recorded stub the agent's `Skill` tool loads (non-tool-callers.test.ts and
 * invoke.http.test.ts).
 */

type ProjectRoot = EventPayload<"project_root">;

const ROOT = "/Users/u/src/core";

const usable: ProjectRoot = {
  project: "core",
  root: ROOT,
  agentsMd: "Rules.",
  skills: [
    { name: "fix-issue", description: "Fix an issue.", digest: "a".repeat(64) },
    { name: "release", description: "Cut a release.", digest: "b".repeat(64) },
  ],
};

const gone: ProjectRoot = {
  project: "core",
  root: ROOT,
  skills: [],
  unavailable: { reason: "gone", message: `The project's root ${ROOT} no longer exists.` },
};

describe("invocableSource", () => {
  it("names where an effective skill comes from", () => {
    expect(invocableSource({ scope: "agent", skill: { plugin: undefined } })).toBe("agent");
    expect(invocableSource({ scope: "agent", skill: { plugin: "superpowers" } })).toBe("agent");
    expect(invocableSource({ scope: "org", skill: { plugin: "superpowers" } })).toBe("plugin");
    expect(invocableSource({ scope: "org", skill: { plugin: undefined } })).toBe("platform");
  });
});

describe("projectInvocables", () => {
  it("lists a usable project's skills as project:<name>, sorted, source project", () => {
    expect(projectInvocables(usable)).toEqual([
      {
        id: "project:fix-issue",
        name: "project:fix-issue",
        description: "Fix an issue.",
        version: 0,
        manual: false,
        fork: false,
        source: "project",
      },
      {
        id: "project:release",
        name: "project:release",
        description: "Cut a release.",
        version: 0,
        manual: false,
        fork: false,
        source: "project",
      },
    ]);
  });

  it("lists nothing for an unavailable project or none", () => {
    expect(projectInvocables(gone)).toEqual([]);
    expect(projectInvocables(undefined)).toEqual([]);
  });

  it("leaves out a skill whose callable name is too long for Skill", () => {
    const long = { name: "x".repeat(60), description: "Long.", digest: "c".repeat(64) };
    expect(projectInvocables({ ...usable, skills: [long] })).toEqual([]);
  });
});

describe("projectSkillBlocked", () => {
  it("is null while the latest usable project still lists the skill", () => {
    expect(projectSkillBlocked(usable, "project:fix-issue")).toBeNull();
  });
  it("is not_found for an unknown name, an unavailable project or none", () => {
    expect(projectSkillBlocked(usable, "project:nope")).toBe("not_found");
    expect(projectSkillBlocked(gone, "project:fix-issue")).toBe("not_found");
    expect(projectSkillBlocked(undefined, "project:fix-issue")).toBe("not_found");
  });
});
