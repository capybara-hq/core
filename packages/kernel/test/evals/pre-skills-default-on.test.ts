import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";

/**
 * Skills default-on spec §9: a recording made while the runtime still pinned skills
 * (`fixtures/pre-skills-default-on/`, never regenerated). Once the runtime stops pinning, nothing
 * else writes logs with pins, so this keeps old logs reconstructing byte for byte: the parent's
 * pinned skill, its version change mid-conversation, the Claude Code tool map, a compaction, and a
 * child dispatched from a template that pins a skill.
 */

type Recorded = { snapshot: CaseSnapshot; requests: ModelRequest[] };
type Fixture = { model: ModelInfo; parent: Recorded; child: Recorded };

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/pre-skills-default-on/conversation.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};

const ofType = <T extends ConversationEvent["type"]>(s: CaseSnapshot, type: T) =>
  toEvents(s).filter((e): e is Ev<T> => e.type === type);

describe("reconstructRequest: a recording from before skills were on by default", () => {
  it("holds pinned skills in the parent and in a template child", () => {
    const parent = fixture.parent.snapshot;
    const catalogs = ofType(parent, "skills_catalog");
    expect(catalogs.map((e) => e.payload.pinned?.map((p) => [p.name, p.version]))).toEqual([
      [["pinned-rules", 1]],
      [["pinned-rules", 2]],
    ]);
    expect(catalogs.every((e) => e.payload.toolMap === CLAUDE_CODE_TOOL_MAP)).toBe(true);
    expect(ofType(parent, "compaction_summary").length).toBeGreaterThan(0);
    expect(ofType(parent, "subagent_dispatched")).toHaveLength(1);
    expect(ofType(parent, "subagent_delivery")).toHaveLength(1);

    const child = fixture.child.snapshot;
    const started = ofType(child, "subagent_started")[0]
      ?.payload as EventPayload<"subagent_started">;
    const pins = (started.definition as { skills?: { pinned?: string[] } }).skills?.pinned;
    expect(pins).toHaveLength(1);
    expect(ofType(child, "skills_catalog")[0]?.payload.pinned?.map((p) => p.name)).toEqual([
      "scout-rules",
    ]);
  });

  it("every recorded model_call of parent and child replays with zero drift", () => {
    for (const side of [fixture.parent, fixture.child]) {
      const calls = ofType(side.snapshot, "model_call");
      expect(calls).toHaveLength(side.requests.length);
      for (const [i, c] of calls.entries()) {
        const out = reconstructRequest(side.snapshot, c.seq, { model: fixture.model });
        expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
        expect(out.request, `model_call seq ${c.seq}`).toEqual(side.requests[i]);
      }
    }
  });

  it("a candidate reports pinned_changed on the parent's pinned calls and subagent_changed on the child's", () => {
    const parent = fixture.parent.snapshot;
    for (const c of ofType(parent, "model_call")) {
      const out = reconstructRequest(parent, c.seq, {
        model: fixture.model,
        params: { effort: "high" },
      });
      // every parent call ran under a pinned snapshot; the request still renders its pins
      expect(out.drift, `model_call seq ${c.seq}`).toContain("pinned_changed");
      expect(out.request.system[0]?.text).toContain("<pinned_skill");
    }
    const child = fixture.child.snapshot;
    for (const c of ofType(child, "model_call")) {
      const out = reconstructRequest(child, c.seq, {
        model: fixture.model,
        params: { effort: "high" },
      });
      expect(out.drift, `model_call seq ${c.seq}`).toContain("subagent_changed");
      expect(out.drift).not.toContain("pinned_changed");
    }
  });
});
