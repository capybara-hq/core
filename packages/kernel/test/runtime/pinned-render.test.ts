import { describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { BEHAVIOR_RULES, buildModelRequest } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { PINNED_SKILLS_HEADER } from "../../src/runtime/context/skills.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * Phase B (spec §9.1, §9.4): pinned skill bodies and the Claude Code tool-name map are rendered
 * from the `skills_catalog` snapshots only: the first in the cached system segment, later changes
 * as one system message at their position, and the current state again after a compaction summary.
 */

type Snapshot = EventPayload<"skills_catalog">;
type Skill = Snapshot["skills"][number];
type Pinned = NonNullable<Snapshot["pinned"]>[number];

const skill = (name: string, version = 1): Skill => ({
  id: `id-${name}`,
  name,
  description: `Use for ${name} tasks.`,
  version,
  source: `skills/${name}-v${version}/`,
});
const pin = (s: Skill, body: string): Pinned => ({
  id: s.id,
  version: s.version,
  name: s.name,
  source: s.source,
  body,
});

const snapshot = (log: Log, p: Snapshot): ConversationEvent =>
  log.add({ type: "skills_catalog", payload: p });

const build = (events: ConversationEvent[]) =>
  buildModelRequest({ events, agent: AGENT, agentVersion: 1, model: MODEL, step: 1 });

const systemText = (events: ConversationEvent[]) => build(events).request.system[0]?.text ?? "";
const notices = (events: ConversationEvent[]) =>
  build(events)
    .request.messages.filter((m) => m.role === "system")
    .map((m) => m.content as string);

const BASE = `${BEHAVIOR_RULES}\n\n${AGENT.instructions}`;
const CATALOG_AB =
  "Skills are available in this conversation. A skill is a set of instructions, sometimes with " +
  "scripts or other files, for a specific kind of task. When a task matches a skill's description, " +
  "call skill_load with the skill's name to read its instructions before you start; do not guess " +
  "what a skill says. Available skills:\n- alpha: Use for alpha tasks.\n- beta: Use for beta tasks.";

describe("pinned skills and the tool map in the request", () => {
  it("no pinned and no toolMap: system text equals today's (golden string)", () => {
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [skill("beta"), { ...skill("alpha"), plugin: "superpowers" }] });
    expect(systemText(log.events)).toBe(`${BASE}\n\n${CATALOG_AB}`);
  });

  it("pinned after the catalog in the system segment, in order", () => {
    const a = skill("alpha");
    const b = skill("beta");
    const log = new Log();
    log.user("hi");
    snapshot(log, {
      skills: [a, b],
      pinned: [pin(b, "\nBeta rules.\n"), pin(a, "Alpha rules.")],
      toolMap: CLAUDE_CODE_TOOL_MAP,
    });
    expect(systemText(log.events)).toBe(
      `${BASE}\n\n${CATALOG_AB}\n\n` +
        "Pinned skills: the owner of this agent pinned these skills, so their instructions apply " +
        "throughout this conversation. Follow them without calling skill_load; call skill_load only " +
        "to copy a pinned skill's files into the sandbox.\n\n" +
        '<pinned_skill name="beta" version="1">\nBeta rules.\n</pinned_skill>\n\n' +
        '<pinned_skill name="alpha" version="1">\nAlpha rules.\n</pinned_skill>' +
        `\n\n${CLAUDE_CODE_TOOL_MAP}`,
    );
    expect(PINNED_SKILLS_HEADER.startsWith("Pinned skills: ")).toBe(true);
    expect(notices(log.events)).toEqual([]);
  });

  it("a pinned new version mid-conversation: one system message with the full body, the sent prefix unchanged", () => {
    const a1 = skill("alpha");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a1], pinned: [pin(a1, "Alpha v1.")] });
    log.modelCall(1);
    log.assistant("ok");
    const before = build(log.events);
    log.user("next");
    const a2 = skill("alpha", 2);
    snapshot(log, { skills: [a2], pinned: [pin(a2, "Alpha v2.")] });
    const after = build(log.events);
    expect(after.request.system).toEqual(before.request.system);
    expect(after.request.messages.slice(0, before.request.messages.length)).toEqual(
      before.request.messages,
    );
    expect(notices(log.events)).toEqual([
      "The skills available in this conversation have changed.\n\n" +
        "Updated skills (call skill_load again before relying on earlier instructions):\n" +
        "- alpha: Use for alpha tasks.\n\n" +
        'Pinned skill "alpha" (version 2) now applies to this conversation and replaces any ' +
        'previous version of it:\n\n<pinned_skill name="alpha" version="2">\nAlpha v2.\n</pinned_skill>',
    ]);
  });

  it("removed pinned: names only", () => {
    const a = skill("alpha");
    const b = skill("beta");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a, b], pinned: [pin(a, "A."), pin(b, "B.")] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a, b] });
    expect(notices(log.events)).toEqual([
      "Pinned skills removed (their pinned instructions no longer apply): alpha, beta",
    ]);
  });

  it("only pinned changed: no catalog change text", () => {
    const a = skill("alpha");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a], pinned: [pin(a, "A.")] });
    expect(notices(log.events)).toEqual([
      'Pinned skill "alpha" (version 1) now applies to this conversation and replaces any ' +
        'previous version of it:\n\n<pinned_skill name="alpha" version="1">\nA.\n</pinned_skill>',
    ]);
  });

  it("the tool map arriving and leaving mid-conversation", () => {
    const a = skill("alpha");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a], toolMap: CLAUDE_CODE_TOOL_MAP });
    log.modelCall(3);
    log.assistant("ok");
    log.user("again");
    snapshot(log, { skills: [a] });
    expect(notices(log.events)).toEqual([
      `The following tool-name map now applies:\n${CLAUDE_CODE_TOOL_MAP}`,
      "The Claude Code tool-name map no longer applies.",
    ]);
  });

  it("compaction: current pinned bodies and tool map restored after the summary", () => {
    const a = skill("alpha");
    const b = skill("beta");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a], pinned: [pin(a, "A.")] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a, b], pinned: [pin(b, "B.")], toolMap: CLAUDE_CODE_TOOL_MAP });
    log.modelCall(4);
    log.assistant("ok");
    const covered = log.events.at(-1)?.seq as number;
    log.summary(covered, "Earlier work.");
    log.user("after");
    const msgs = build(log.events).request.messages;
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]).toEqual({
      role: "system",
      content:
        "Skills available in this conversation now (this replaces any earlier list of skills; call " +
        "skill_load with a name to read a skill's instructions):\n" +
        "- alpha: Use for alpha tasks.\n- beta: Use for beta tasks.\n\n" +
        "Pinned skills now (this replaces any earlier pinned skills):\n\n" +
        '<pinned_skill name="beta" version="1">\nB.\n</pinned_skill>\n\n' +
        `The following tool-name map now applies:\n${CLAUDE_CODE_TOOL_MAP}`,
    });
    expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("compaction after every pin was removed says so", () => {
    const a = skill("alpha");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a], pinned: [pin(a, "A.")] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a] });
    log.modelCall(4);
    log.assistant("ok");
    log.summary(log.events.at(-1)?.seq as number, "Earlier work.");
    log.user("after");
    expect(notices(log.events)).toEqual([
      "No skills are pinned now (this replaces any earlier pinned skills).",
    ]);
  });
});
