import { describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { BEHAVIOR_RULES, buildModelRequest } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * Phase B (spec §9.4): the Claude Code tool-name map is rendered from the `skills_catalog`
 * snapshots only: the first in the cached system segment, later changes as one system message at
 * their position, and the current state again after a compaction summary.
 */

type Snapshot = EventPayload<"skills_catalog">;
type Skill = Snapshot["skills"][number];

const skill = (name: string, version = 1): Skill => ({
  id: `id-${name}`,
  name,
  description: `Use for ${name} tasks.`,
  version,
  source: `skills/${name}-v${version}/`,
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
  "call Skill with the skill's name to read its instructions before you start; do not guess " +
  "what a skill says. Available skills:\n- alpha: Use for alpha tasks.\n- beta: Use for beta tasks.";

describe("the tool map in the request", () => {
  it("no toolMap: system text equals today's (golden string)", () => {
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [skill("beta"), { ...skill("alpha"), plugin: "superpowers" }] });
    expect(systemText(log.events)).toBe(`${BASE}\n\n${CATALOG_AB}`);
  });

  it("the tool map after the catalog in the system segment", () => {
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [skill("alpha"), skill("beta")], toolMap: CLAUDE_CODE_TOOL_MAP });
    expect(systemText(log.events)).toBe(`${BASE}\n\n${CATALOG_AB}\n\n${CLAUDE_CODE_TOOL_MAP}`);
    expect(notices(log.events)).toEqual([]);
  });

  it("an updated skill is listed as updated", () => {
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [skill("alpha")] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [skill("alpha", 2)] });
    expect(notices(log.events)).toEqual([
      "The skills available in this conversation have changed.\n\n" +
        "Updated skills (call Skill again before relying on earlier instructions):\n" +
        "- alpha: Use for alpha tasks.",
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

  it("compaction: the current catalog and tool map restored after the summary", () => {
    const a = skill("alpha");
    const b = skill("beta");
    const log = new Log();
    log.user("hi");
    snapshot(log, { skills: [a] });
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    snapshot(log, { skills: [a, b], toolMap: CLAUDE_CODE_TOOL_MAP });
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
        "Skill with a name to read a skill's instructions):\n" +
        "- alpha: Use for alpha tasks.\n- beta: Use for beta tasks.\n\n" +
        `The following tool-name map now applies:\n${CLAUDE_CODE_TOOL_MAP}`,
    });
    expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
  });
});
