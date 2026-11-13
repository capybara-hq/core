import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { buildModelRequest } from "../../../src/runtime/context/build.js";
import { compactionPlan } from "../../../src/runtime/context/compaction.js";
import { TOOLS_UNSUPPORTED_REMINDER } from "../../../src/runtime/context/reminders.js";
import {
  previousToolSet,
  toolSetChange,
  toolsChangedText,
} from "../../../src/runtime/context/tool-changes.js";
import { AGENT, compactionSettings, Log, MODEL, NO_TAIL_LIMIT } from "./fixtures.js";

/** A model_call that offered `tools` (and a ToolSearch `catalog`); `tools` undefined = older log. */
function call(
  log: Log,
  tools: string[] | undefined,
  opts: { step?: number; catalog?: string[]; runId?: string } = {},
): ConversationEvent {
  const ref = (key: string) => ({ key, specHash: `h-${key}` });
  return log.add(
    {
      type: "model_call",
      payload: {
        step: opts.step ?? 1,
        attempt: 1,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: {
          fromSeq: 1,
          toSeq: Math.max(1, log.events.at(-1)?.seq ?? 1),
          summarySeq: null,
          systemHash: "x",
          reminderSeqs: [],
          ...(tools !== undefined && { tools: tools.map(ref) }),
          ...(opts.catalog !== undefined && { catalog: opts.catalog.map(ref) }),
        },
      },
    },
    opts.runId ?? "run-1",
  );
}

const changed = (log: Log, added: string[], removed: string[], step = 2) =>
  log.add({ type: "tools_changed", payload: { step, added, removed } });

describe("toolSetChange", () => {
  it("is null before the first request (the first list is the baseline) and when unchanged", () => {
    const log = new Log();
    log.user("hi");
    expect(toolSetChange(log.events, ["A"])).toBeNull();
    call(log, ["B", "A"]);
    expect(toolSetChange(log.events, ["A", "B"])).toBeNull();
  });

  it("diffs against the last request, names sorted", () => {
    const log = new Log();
    call(log, ["A", "Z"]);
    call(log, ["A", "B"], { step: 2 });
    expect(toolSetChange(log.events, ["D", "C", "A"])).toEqual({
      added: ["C", "D"],
      removed: ["B"],
    });
  });

  it("counts the ToolSearch catalog as offered (the union is the resolved set)", () => {
    const log = new Log();
    call(log, ["ToolSearch", "mcp__x__a"], { catalog: ["mcp__x__a", "mcp__x__b"] });
    expect(toolSetChange(log.events, ["ToolSearch", "mcp__x__a", "mcp__x__b"])).toBeNull();
  });

  it("applies a change logged after the last request (a retried step writes nothing new)", () => {
    const log = new Log();
    call(log, ["A"]);
    changed(log, ["B"], []);
    expect([...(previousToolSet(log.events) ?? [])].sort()).toEqual(["A", "B"]);
    expect(toolSetChange(log.events, ["A", "B"])).toBeNull();
    expect(toolSetChange(log.events, ["B"])).toEqual({ added: [], removed: ["A"] });
  });

  it("skips calls without recorded tools and a call stripped for a model without tools", () => {
    const log = new Log();
    expect(previousToolSet(log.events)).toBeNull();
    call(log, undefined);
    expect(previousToolSet(log.events)).toBeNull();
    call(log, ["A"], { step: 2 });
    log.reminder(TOOLS_UNSUPPORTED_REMINDER, 3);
    call(log, [], { step: 3 });
    expect(toolSetChange(log.events, ["A"])).toBeNull();
    // an agent with no tools at all records an empty list: that is a real baseline
    call(log, [], { step: 4 });
    expect(toolSetChange(log.events, ["A"])).toEqual({ added: ["A"], removed: [] });
  });
});

describe("toolsChangedText", () => {
  it("names what is new and what is gone, and says the current list wins", () => {
    expect(toolsChangedText({ added: ["WebFetch", "WebSearch"], removed: ["Agent"] })).toBe(
      "Your tools changed. Now available: WebFetch, WebSearch. No longer available: Agent. Use the " +
        "current tool list; it replaces anything said earlier in this conversation about which " +
        "tools you have.",
    );
    expect(toolsChangedText({ added: [], removed: ["Agent"] })).toBe(
      "Your tools changed. No longer available: Agent. Use the current tool list; it replaces " +
        "anything said earlier in this conversation about which tools you have.",
    );
  });
});

describe("buildModelRequest renders tools_changed", () => {
  it("as a system message at its log position", () => {
    const log = new Log();
    log.user("search the web");
    call(log, ["A"]);
    log.assistant("I have no web search tool.");
    log.user("try again");
    changed(log, ["WebSearch"], []);
    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
    });
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "search the web" }] },
      { role: "assistant", content: [{ type: "text", text: "I have no web search tool." }] },
      { role: "user", content: [{ type: "text", text: "try again" }] },
      { role: "system", content: toolsChangedText({ added: ["WebSearch"], removed: [] }) },
    ]);
  });

  it("drops a change the summary covers (the request's tool list is current)", () => {
    const log = new Log();
    log.turn(1);
    const c = changed(log, ["WebSearch"], []);
    log.turn(2);
    log.summary(c.seq + 2, "They asked twice.");
    log.user("question 3");
    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
    });
    expect(request.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("keeps the change in the compaction transcript", () => {
    const log = new Log();
    log.turn(1);
    changed(log, ["WebSearch"], ["Agent"]);
    log.turn(2);
    log.turn(3);
    log.turn(4);
    log.turn(5);
    const plan = compactionPlan(
      log.events,
      compactionSettings({ keepRecentTurns: 2 }),
      NO_TAIL_LIMIT,
    );
    expect(plan?.transcript).toContain(
      `System reminder: ${toolsChangedText({ added: ["WebSearch"], removed: ["Agent"] })}`,
    );
  });
});
