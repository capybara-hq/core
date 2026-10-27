import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanInvocationKeys } from "../../src/skills/invocation-keys.js";
import { checkSkillFiles, type SkillPackageFile } from "../../src/skills/package.js";

/**
 * Phase D batch 1 review M2 / M3 / I4: the lenient readers (catalog install and upgrade of stored
 * files, the Claude Code translation) drop invocation keys the strict checks would refuse, with the
 * reason, instead of storing an unusable invocation or refusing the skill.
 */

const fileOf = (text: string): SkillPackageFile => {
  const data = new TextEncoder().encode(text);
  return {
    path: "SKILL.md",
    size: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
};
const md = (front: string) => `---\nname: s\ndescription: S.\n${front}---\nBody.\n`;

describe("cleanInvocationKeys", () => {
  it("keeps valid keys and the frontmatter's other keys untouched", () => {
    const fm = {
      name: "s",
      "disable-model-invocation": true,
      "argument-hint": ["issue"],
      context: "fork",
      agent: "Explore",
      arguments: ["a"],
      "allowed-tools": 3,
    };
    expect(cleanInvocationKeys(fm)).toEqual({ frontmatter: fm, dropped: [] });
  });

  it("drops each wrong-typed or over-limit key with the strict check's reason", () => {
    const r = cleanInvocationKeys({
      name: "s",
      "disable-model-invocation": "true",
      "user-invocable": 0,
      context: "inline",
      agent: "a".repeat(131),
      "argument-hint": [{ optional: "files" }],
      arguments: "x",
    });
    expect(r.frontmatter).toEqual({ name: "s" });
    expect(r.dropped).toEqual([
      { key: "disable-model-invocation", problem: "disable-model-invocation must be a boolean" },
      { key: "user-invocable", problem: "user-invocable must be a boolean" },
      { key: "context", problem: 'context must be "fork"' },
      { key: "agent", problem: "agent must be a string of 1-130 characters" },
      {
        key: "argument-hint",
        problem: "argument-hint must be a string of at most 200 characters",
      },
      { key: "arguments", problem: "arguments must be a list of at most 20 names" },
    ]);
  });

  it("drops both flags of a skill nobody could use", () => {
    expect(
      cleanInvocationKeys({ "disable-model-invocation": true, "user-invocable": false }),
    ).toEqual({
      frontmatter: {},
      dropped: [
        {
          key: "disable-model-invocation, user-invocable",
          problem:
            "a skill with disable-model-invocation: true and user-invocable: false cannot be used",
        },
      ],
    });
  });
});

describe("checkSkillFiles on stored files (lenient)", () => {
  it("never stores { model: false, user: false } (M2)", () => {
    const f = fileOf(md("disable-model-invocation: true\nuser-invocable: false\n"));
    expect(() => checkSkillFiles([f])).toThrow();
    expect(checkSkillFiles([f], { invocationKeys: false }).invocation).toEqual({
      model: true,
      user: true,
    });
  });

  it("drops an over-long argument-hint and agent (M2)", () => {
    const f = fileOf(
      md(`argument-hint: '${"h".repeat(201)}'\ncontext: fork\nagent: ${"a".repeat(131)}\n`),
    );
    expect(checkSkillFiles([f], { invocationKeys: false }).invocation).toEqual({
      model: true,
      user: true,
      fork: {},
    });
  });

  it("keeps the valid keys next to a dropped one", () => {
    const f = fileOf(md("disable-model-invocation: true\nargument-hint: 7\n"));
    expect(checkSkillFiles([f], { invocationKeys: false }).invocation).toEqual({
      model: false,
      user: true,
    });
  });
});
