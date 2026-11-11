import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { BEHAVIOR_RULES, buildModelRequest } from "../../../src/runtime/context/build.js";
import {
  type CatalogSkill,
  MORE_SKILLS_HEADER,
  SKILL_TEXTS,
  sameSkills,
  skillsChangeText,
  skillsCurrentText,
  snapshotSystemText,
} from "../../../src/runtime/context/skills.js";
import {
  applyCatalogBudget,
  type BudgetTier,
  budgetTier,
  catalogLineChars,
} from "../../../src/skills/catalog.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

/**
 * The skills catalog budget (skills default-on spec §7): the cut is decided when a snapshot is
 * written (`nameOnly`), and rendering stays a pure function of the snapshot. A snapshot without
 * `nameOnly` (every one before phase 2) renders byte for byte as before.
 */

const skill = (
  name: string,
  extra: Partial<CatalogSkill> = {},
  description = `Use for ${name} tasks.`,
): CatalogSkill => ({
  id: `id-${name}`,
  name,
  description,
  version: 1,
  source: `skills/${name}-v1/`,
  ...extra,
});

const nameOnly = (s: CatalogSkill): CatalogSkill => ({ ...s, nameOnly: true });

const build = (events: ConversationEvent[]) =>
  buildModelRequest({ events, agent: AGENT, agentVersion: 1, model: MODEL, step: 1 });

describe("rendering name-only entries", () => {
  it("an old snapshot (no nameOnly) renders byte for byte as before", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.add({
      type: "skills_catalog",
      payload: { skills: [skill("zeta"), skill("alpha", {}, "Line one.\n  Line two.")] },
    });
    // the exact text rendered before phase 2: header, then the described lines by name
    expect(build(log.events).request.system[0]?.text).toBe(
      `${BEHAVIOR_RULES}\n\n${AGENT.instructions}\n\n` +
        "Skills are available in this conversation. A skill is a set of instructions, sometimes " +
        "with scripts or other files, for a specific kind of task. When a task matches a skill's " +
        "description, call Skill with the skill's name to read its instructions before you start; " +
        "do not guess what a skill says. Available skills:\n" +
        "- alpha: Line one. Line two.\n" +
        "- zeta: Use for zeta tasks.",
    );
  });

  it("the system catalog lists described entries by name, then the name-only ones under the heading", () => {
    const text = snapshotSystemText({
      skills: [nameOnly(skill("zulu")), skill("mike"), nameOnly(skill("bravo")), skill("alpha")],
    });
    expect(MORE_SKILLS_HEADER).toBe(
      "More skills (names only; call Skill with the name to read one):",
    );
    expect(text).toBe(
      `${SKILL_TEXTS.skillsCatalogHeader}\n` +
        "- alpha: Use for alpha tasks.\n" +
        "- mike: Use for mike tasks.\n" +
        `${MORE_SKILLS_HEADER}\n` +
        "bravo, zulu",
    );
  });

  it("a listing with only name-only entries has no empty line", () => {
    expect(skillsCurrentText([nameOnly(skill("beta")), nameOnly(skill("alpha"))])).toBe(
      `${SKILL_TEXTS.currentSkills}\n${MORE_SKILLS_HEADER}\nalpha, beta`,
    );
  });

  it("sameSkills compares nameOnly (absent = false)", () => {
    expect(sameSkills([skill("a")], [skill("a")])).toBe(true);
    expect(sameSkills([skill("a")], [nameOnly(skill("a"))])).toBe(false);
    expect(sameSkills([nameOnly(skill("a"))], [nameOnly(skill("a"))])).toBe(true);
  });

  it("an entry crossing the budget is an updated skill, each way; new name-only skills are listed by name", () => {
    const before = [skill("alpha"), skill("beta")];
    const after = [skill("alpha"), nameOnly(skill("beta")), nameOnly(skill("gamma"))];
    expect(skillsChangeText(before, after)).toBe(
      "The skills available in this conversation have changed.\n\n" +
        `${SKILL_TEXTS.newSkills}\n${MORE_SKILLS_HEADER}\ngamma\n\n` +
        `${SKILL_TEXTS.updatedSkills}\n${MORE_SKILLS_HEADER}\nbeta`,
    );
    expect(skillsChangeText(after, before)).toBe(
      "The skills available in this conversation have changed.\n\n" +
        `${SKILL_TEXTS.updatedSkills}\n- beta: Use for beta tasks.\n\n` +
        "Removed skills (no longer available; do not use them): gamma",
    );
  });

  it("a later snapshot that only moves an entry across the budget renders an appended notice; the prefix stays", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.add({ type: "skills_catalog", payload: { skills: [skill("alpha"), skill("beta")] } });
    log.modelCall(1);
    log.assistant("ok");
    const first = build(log.events);
    log.user("again");
    log.runStarted();
    log.add({
      type: "skills_catalog",
      payload: { skills: [skill("alpha"), nameOnly(skill("beta"))] },
    });
    const second = build(log.events);
    expect(second.request.system).toEqual(first.request.system);
    expect(second.request.messages.at(-1)).toEqual({
      role: "system",
      content:
        "The skills available in this conversation have changed.\n\n" +
        `${SKILL_TEXTS.updatedSkills}\n${MORE_SKILLS_HEADER}\nbeta`,
    });
  });
});

describe("applyCatalogBudget", () => {
  const tiers: Record<string, BudgetTier> = { own: 0, builtin: 1, org: 2, plug: 3 };
  const tierOf = (s: CatalogSkill) => tiers[s.name.split("-")[0] as string] as BudgetTier;

  it("everything fits: no entry is name-only and the tiers are never read", async () => {
    const skills = [skill("org-a"), nameOnly(skill("plug-b"))];
    const read = vi.fn(async () => tierOf);
    const r = await applyCatalogBudget(skills, 10_000, read);
    expect(read).not.toHaveBeenCalled();
    expect(r.skills).toEqual([skill("org-a"), skill("plug-b")]);
    expect(r.nameOnly).toBe(0);
    expect(r.characters).toBe(skills.map(catalogLineChars).reduce((a, b) => a + b));
  });

  it("ranks own, builtin, org, plugin, then by name; a prefix keeps descriptions, the rest are name-only", async () => {
    // input in name order, as the resolver gives it
    const skills = [
      skill("builtin-z"),
      skill("org-a"),
      skill("org-b"),
      skill("own-y"),
      skill("plug-0"),
    ];
    const cost = (n: string) => catalogLineChars(skill(n));
    // own-y, builtin-z and org-a fit exactly; org-b is past the budget, plug-0 after it
    const budget = cost("own-y") + cost("builtin-z") + cost("org-a");
    const r = await applyCatalogBudget(skills, budget, async () => tierOf);
    expect(r.skills.map((s) => [s.name, s.nameOnly === true])).toEqual([
      ["builtin-z", false],
      ["org-a", false],
      ["org-b", true],
      ["own-y", false],
      ["plug-0", true],
    ]);
    expect(r.nameOnly).toBe(2);
    // one short of the exact fit cuts org-a too, and everything ranked after it
    const tight = await applyCatalogBudget(skills, budget - 1, async () => tierOf);
    expect(tight.skills.filter((s) => s.nameOnly).map((s) => s.name)).toEqual([
      "org-a",
      "org-b",
      "plug-0",
    ]);
  });

  it("the cost of a line is its code points as rendered (flattened, clipped) plus the line break", () => {
    expect(catalogLineChars(skill("a", {}, "x  y\n z"))).toBe("- a: x y z".length + 1);
    expect(catalogLineChars(skill("a", {}, "é".repeat(1000)))).toBe("- a: ".length + 300 + 1);
  });
});

describe("budgetTier", () => {
  const builtin = { plugins: new Set(["core"]), ids: new Set(["pinned-copy"]) };
  const r = (
    s: Partial<CatalogSkill>,
    scope: "org" | "agent" = "org",
    origin: "org" | "platform" = "org",
  ) => ({ skill: skill("x", s), scope, origin });

  it("the agent's own, builtin, the org's own, then plugin skills", () => {
    expect(budgetTier(r({ plugin: "core" }, "agent", "platform"), builtin)).toBe(0);
    expect(budgetTier(r({ plugin: "core" }, "org", "platform"), builtin)).toBe(1);
    expect(budgetTier(r({ id: "pinned-copy", plugin: "core" }), builtin)).toBe(1);
    expect(budgetTier(r({}), builtin)).toBe(2);
    // an org skill whose provenance names the builtin plugin is not the builtin skill
    expect(budgetTier(r({ plugin: "core" }), builtin)).toBe(3);
    expect(budgetTier(r({ plugin: "docs" }, "org", "platform"), builtin)).toBe(3);
  });
});
