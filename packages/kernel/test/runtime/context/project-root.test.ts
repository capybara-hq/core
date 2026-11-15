import { describe, expect, it } from "vitest";
import type { EventPayload } from "../../../src/conversations/events.js";
import { buildModelRequest } from "../../../src/runtime/context/build.js";
import { compactionPlan } from "../../../src/runtime/context/compaction.js";
import {
  hasProjectSkills,
  latestProjectRoot,
  overlongProjectSkills,
  PROJECT_SKILL_PREFIX,
  projectRootText,
  projectSkillName,
} from "../../../src/runtime/context/project-root.js";
import { skillLoadOffered } from "../../../src/skills/catalog.js";
import { AGENT, compactionSettings, Log, MODEL, NO_TAIL_LIMIT } from "./fixtures.js";

type ProjectRoot = EventPayload<"project_root">;

const usable = (over: Partial<ProjectRoot> = {}): ProjectRoot => ({
  project: "core",
  root: "/Users/u/src/core",
  agentsMd: "# AGENTS.md\n\nRun pnpm test before you commit.",
  skills: [
    { name: "fix-issue", description: "Fix a GitHub issue end to end.", digest: "a".repeat(64) },
    { name: "release", description: "Cut a release.", digest: "b".repeat(64) },
  ],
  ...over,
});

const gone: ProjectRoot = {
  project: "core",
  root: "/Users/u/src/core",
  skills: [],
  unavailable: {
    reason: "gone",
    message: "The project's root /Users/u/src/core no longer exists on the device.",
  },
};

const pr = (log: Log, payload: ProjectRoot) => log.add({ type: "project_root", payload });

const build = (log: Log) =>
  buildModelRequest({ events: log.events, agent: AGENT, agentVersion: 1, model: MODEL, step: 1 })
    .request;

const systems = (log: Log) =>
  build(log)
    .messages.filter((m) => m.role === "system")
    .map((m) => String(m.content));

describe("project_root: the text", () => {
  it("names the project and its root, carries AGENTS.md, the conflict rule and the skills as project:<name>", () => {
    const text = projectRootText(usable());
    expect(text).toContain('"core"');
    expect(text).toContain("/Users/u/src/core");
    expect(text).toContain(
      "<agents-md>\n# AGENTS.md\n\nRun pnpm test before you commit.\n</agents-md>",
    );
    expect(text).toMatch(/your own instructions .*win/i);
    expect(text).toContain("- project:fix-issue: Fix a GitHub issue end to end.");
    expect(text).toContain("- project:release: Cut a release.");
    expect(text).not.toMatch(/was cut at|more skills than/i);
    // English only (model-visible)
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("is a pure function of the payload (the same bytes every time)", () => {
    expect(projectRootText(usable())).toBe(projectRootText(usable()));
  });

  it("a truncated AGENTS.md and a cut skill list say so", () => {
    const text = projectRootText(usable({ agentsMdTruncated: true, skillsTruncated: true }));
    expect(text).toMatch(/AGENTS\.md .*cut/i);
    expect(text).toContain("/Users/u/src/core/AGENTS.md");
    expect(text).toMatch(/more skills/i);
  });

  it("without AGENTS.md or skills: no AGENTS.md block, no skills list", () => {
    const text = projectRootText(usable({ agentsMd: undefined, skills: [] }));
    expect(text).not.toContain("<agents-md>");
    expect(text).not.toContain("project:");
    expect(text).toContain("/Users/u/src/core");
  });

  it("an unavailable project: one line with the reason and that earlier project instructions no longer apply", () => {
    const text = projectRootText(gone);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("not available");
    expect(text).toContain("no longer exists on the device");
    expect(text).toMatch(/earlier project instructions and skills no longer apply/i);
    expect(text).not.toContain("<agents-md>");
  });

  it("leaves out a skill whose qualified name is over the Skill schema's 64 characters", () => {
    const long = "s".repeat(64 - PROJECT_SKILL_PREFIX.length + 1);
    const fits = "f".repeat(64 - PROJECT_SKILL_PREFIX.length);
    const p = usable({
      skills: [
        { name: long, description: "Too long.", digest: "c".repeat(64) },
        { name: fits, description: "Fits.", digest: "d".repeat(64) },
      ],
    });
    expect(projectSkillName(fits)).toHaveLength(64);
    expect(overlongProjectSkills(p)).toEqual([long]);
    const text = projectRootText(p);
    expect(text).not.toContain(long);
    expect(text).toContain(`- project:${fits}: Fits.`);
  });
});

describe("project_root: request building", () => {
  it("renders at its position as a system message, after the agent's own instructions in system", () => {
    const log = new Log();
    log.user("hello");
    log.assistant("hi");
    pr(log, usable());
    log.user("fix #12");
    const req = build(log);
    expect(req.system[0]?.text).toContain(AGENT.instructions);
    expect(req.system[0]?.text).not.toContain("AGENTS.md");
    expect(req.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: projectRootText(usable()) },
      { role: "user", content: [{ type: "text", text: "fix #12" }] },
    ]);
  });

  it("a later unavailable event renders its own line at its position; the earlier text stays (append-only)", () => {
    const log = new Log();
    pr(log, usable());
    log.user("hello");
    log.assistant("hi");
    pr(log, gone);
    log.user("again");
    expect(systems(log)).toEqual([projectRootText(usable()), projectRootText(gone)]);
  });

  it("a log without the event renders exactly as before", () => {
    const log = new Log();
    log.user("hello");
    log.assistant("hi");
    log.user("again");
    const before = build(log);
    expect(before.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("after a summary covering it: the latest one follows the summary, after plugin context", () => {
    const log = new Log();
    pr(log, usable({ agentsMd: "old" })); // seq 1
    log.user("hello"); // seq 2
    pr(log, usable()); // seq 3
    log.add({
      type: "plugin_context",
      payload: { plugin: "memory", text: "m", hash: "e".repeat(64) },
    }); // seq 4
    log.assistant("hi"); // seq 5
    log.summary(5, "S");
    log.user("next");
    const msgs = build(log).messages;
    expect(msgs.map((m) => (m.role === "system" ? String(m.content) : m.role))).toEqual([
      "user",
      '<plugin-context plugin="memory">\nm\n</plugin-context>',
      projectRootText(usable()),
      "user",
    ]);
  });

  it("after a summary: a covered unavailable event follows it instead of the earlier usable one", () => {
    const log = new Log();
    pr(log, usable()); // seq 1
    log.user("hello"); // seq 2
    log.assistant("hi"); // seq 3
    pr(log, gone); // seq 4
    log.summary(4, "S");
    log.user("next");
    expect(systems(log)).toEqual([projectRootText(gone)]);
  });

  it("an event after the summary renders at its position only", () => {
    const log = new Log();
    log.user("hello");
    log.assistant("hi");
    log.summary(2, "S");
    pr(log, usable());
    log.user("next");
    expect(systems(log)).toEqual([projectRootText(usable())]);
  });

  it("is left out of the compaction transcript", () => {
    const log = new Log();
    pr(log, usable({ agentsMd: "SECRET-RULES" }));
    log.user("question");
    log.assistant("answer");
    log.user("latest");
    const plan = compactionPlan(
      log.events,
      compactionSettings({ keepRecentTurns: 1 }),
      NO_TAIL_LIMIT,
    );
    expect(plan?.transcript).toBe("User: question\n\nAssistant: answer");
  });

  it("latestProjectRoot: the last event at or before the seq", () => {
    const log = new Log();
    pr(log, usable()); // 1
    pr(log, gone); // 2
    expect(latestProjectRoot(log.events, 1)?.unavailable).toBeUndefined();
    expect(latestProjectRoot(log.events, 2)?.unavailable?.reason).toBe("gone");
    expect(latestProjectRoot(log.events, 0)).toBeUndefined();
  });
});

describe("project_root: Skill is offered", () => {
  it("a logged project with skills offers Skill even without a skills catalog", () => {
    expect(skillLoadOffered(undefined, false, true)).toBe(true);
    expect(skillLoadOffered(undefined, false, false)).toBe(false);
  });

  it("hasProjectSkills: a logged project with at least one skill, unavailable later or not", () => {
    const log = new Log();
    pr(log, usable({ skills: [] }));
    expect(hasProjectSkills(log.events)).toBe(false);
    pr(log, usable());
    pr(log, gone);
    expect(hasProjectSkills(log.events)).toBe(true);
  });
});
