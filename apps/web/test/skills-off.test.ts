import { describe, expect, it } from "vitest";
import type { DisabledSkillRef } from "../src/lib/agents";
import type { SkillSummary } from "../src/lib/skills";
import {
  canonicalOff,
  disallowedToOff,
  offToDisallowed,
  setOwnSkills,
  setPluginSkills,
  skillIsOff,
  skillNameKeys,
} from "../src/lib/skills-off";

const skill = (id: string, name: string, over: Partial<SkillSummary> = {}): SkillSummary => ({
  id,
  scope: "org",
  agentId: null,
  name,
  description: "",
  currentVersion: 1,
  createdBy: "a1",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const KNOWN = ["a", "b", "c"];

describe("skills off (skills default-on spec §4, §10)", () => {
  it("a plugin entry turns off its names or the whole plugin; a builtin skill never is off", () => {
    const off: DisabledSkillRef[] = [{ kind: "plugin", plugin: "p", skills: ["a"] }];
    expect(skillIsOff(off, skill("1", "a", { plugin: "p" }))).toBe(true);
    expect(skillIsOff(off, skill("2", "b", { plugin: "p" }))).toBe(false);
    expect(
      skillIsOff(
        [{ kind: "plugin", plugin: "p", skills: "all" }],
        skill("3", "z", { plugin: "p" }),
      ),
    ).toBe(true);
    expect(
      skillIsOff(
        [{ kind: "plugin", plugin: "p", skills: "all" }],
        skill("4", "a", { plugin: "p", builtin: true }),
      ),
    ).toBe(false);
    // a skill entry names a skill without a plugin by id, or a linked copy's id
    expect(
      skillIsOff([{ kind: "skill", skillId: "copy" }], skill("5", "x", { linkedIds: ["copy"] })),
    ).toBe(true);
  });

  it("rows collapse to the whole plugin when the last goes off, and expand back when one comes on", () => {
    let off: DisabledSkillRef[] = [];
    for (const n of KNOWN) off = setPluginSkills(off, "p", KNOWN, [n], false, "row");
    expect(off).toEqual([{ kind: "plugin", plugin: "p", skills: "all" }]);
    off = setPluginSkills(off, "p", KNOWN, ["b"], true, "row");
    expect(off).toEqual([{ kind: "plugin", plugin: "p", skills: ["a", "c"] }]);
    off = setPluginSkills(off, "p", KNOWN, ["a", "c"], true, "row");
    expect(off).toEqual([]);
  });

  it("the head writes the whole plugin; a filtered head names the shown rows and never writes all", () => {
    const other: DisabledSkillRef = { kind: "skill", skillId: "s9" };
    expect(setPluginSkills([other], "p", KNOWN, KNOWN, false, "head")).toEqual([
      other,
      { kind: "plugin", plugin: "p", skills: "all" },
    ]);
    expect(
      setPluginSkills(
        [{ kind: "plugin", plugin: "p", skills: "all" }],
        "p",
        KNOWN,
        KNOWN,
        true,
        "head",
      ),
    ).toEqual([]);
    expect(setPluginSkills([], "p", KNOWN, KNOWN, false, "shown")).toEqual([
      { kind: "plugin", plugin: "p", skills: ["a", "b", "c"] },
    ]);
    // a filtered head turning rows on out of "all" names the rest
    expect(
      setPluginSkills(
        [{ kind: "plugin", plugin: "p", skills: "all" }],
        "p",
        KNOWN,
        ["a"],
        true,
        "shown",
      ),
    ).toEqual([{ kind: "plugin", plugin: "p", skills: ["b", "c"] }]);
  });

  it("skills without a plugin go off one by one by their key", () => {
    const rows = [skill("o1", "csv"), skill("o2", "tone")];
    const off = setOwnSkills([], rows, false);
    expect(off).toEqual([
      { kind: "skill", skillId: "o1" },
      { kind: "skill", skillId: "o2" },
    ]);
    expect(setOwnSkills(off, [rows[0] as SkillSummary], true)).toEqual([
      { kind: "skill", skillId: "o2" },
    ]);
    expect(setOwnSkills([], rows, false, skillNameKeys)).toEqual([
      { kind: "skill", skillId: "csv" },
      { kind: "skill", skillId: "tone" },
    ]);
  });

  it("a template's disallowedSkills round-trips through off entries", () => {
    const disallowed = ["docs:gamma", "superpowers:*", "tone", "docs:delta"];
    const off = disallowedToOff(disallowed);
    expect(off).toEqual([
      { kind: "plugin", plugin: "docs", skills: ["gamma", "delta"] },
      { kind: "plugin", plugin: "superpowers", skills: "all" },
      { kind: "skill", skillId: "tone" },
    ]);
    expect(offToDisallowed(canonicalOff(off))).toEqual([
      "docs:delta",
      "docs:gamma",
      "superpowers:*",
      "tone",
    ]);
  });
});
