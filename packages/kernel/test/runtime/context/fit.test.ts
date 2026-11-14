import type { ModelInfo, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildModelRequest } from "../../../src/runtime/context/build.js";
import {
  applyFit,
  clampOutput,
  effectiveReserve,
  estimateAfterFit,
  FIT_TRUNCATION_NOTE,
  type FitPlan,
  planFit,
} from "../../../src/runtime/context/fit.js";
import { estimateTokens } from "../../../src/runtime/context/tokens.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

/**
 * The hard fit guard (context compaction spec §4.3): the output cap and reserve are first clamped to
 * what the window leaves, then a request over the target is trimmed with a deterministic plan of
 * message / block indexes, so `applyFit` alone replays it byte-for-byte.
 */

const WINDOW = 100_000;
const OUTPUT = 1_000;
const MODEL_FIT: ModelInfo = { ...MODEL, contextWindow: WINDOW, maxOutputTokens: OUTPUT };

function build(log: Log): { request: ModelRequest; estimate: number } {
  const { request, mediaTokens } = buildModelRequest({
    events: log.events,
    agent: AGENT,
    agentVersion: 1,
    model: MODEL_FIT,
    step: 0,
  });
  return {
    request,
    estimate: estimateTokens(request.messages, request.system, request.tools, mediaTokens),
  };
}

/** A reserve that, with `WINDOW` and `OUTPUT` under their clamps, makes the target equal `target`. */
const reserveFor = (target: number): number => WINDOW - OUTPUT - target;

const plan = (log: Log, request: ModelRequest, estimate: number, target: number): FitPlan | null =>
  planFit({
    events: log.events,
    request,
    model: MODEL_FIT,
    maxOutputTokens: OUTPUT,
    reserveTokens: reserveFor(target),
    estimate,
  });

const tokens = (m: ModelMessage): number => estimateTokens([m], [], []);

/** Every tool_result in `messages` has its tool_call before it and vice versa (no split pair). */
function pairsIntact(messages: readonly ModelMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    for (const b of m.content) {
      if (b.type === "tool_call") calls.add(b.id);
      if (b.type === "tool_result") results.add(b.callId);
    }
  }
  return calls.size === results.size && [...calls].every((id) => results.has(id));
}

describe("clampOutput / effectiveReserve", () => {
  it("lowers the output cap so input + output fits the window, and keeps at least one token", () => {
    expect(clampOutput(1_000, 5_000, 200)).toBe(800);
    expect(clampOutput(1_000, 5_000, 999)).toBe(1);
    expect(clampOutput(1_000, 5_000, 1_200)).toBe(1);
    // a cap that fits the window is unchanged
    expect(clampOutput(10_000, 1_000, 200)).toBe(1_000);
  });

  it("keeps the reserve only when the clamped output leaves room below the window", () => {
    // W - O' - 1 = 8_999, so the configured 8_000 is kept
    expect(effectiveReserve(10_000, 1_000, 8_000)).toBe(8_000);
    // W - O' - 1 = 199, so the configured 8_000 is reduced to 199
    expect(effectiveReserve(1_000, 800, 8_000)).toBe(199);
    expect(effectiveReserve(1_000, 999, 8_000)).toBe(0);
  });

  it("a large requested cap on a small window still yields a plan (the trim runs)", () => {
    const log = new Log();
    log.user(`a huge latest message ${"word ".repeat(2_000)}`);
    const { request, estimate } = build(log);
    // W = 4_000, O = 5_000, R = 0: O' = 4_000 - estimate, the target is the estimate, so it fits;
    // with a reserve the target is below the input and the tail is truncated
    const wide: ModelInfo = { ...MODEL_FIT, contextWindow: 4_000 };
    expect(
      planFit({
        events: log.events,
        request,
        model: wide,
        maxOutputTokens: 5_000,
        reserveTokens: 0,
        estimate,
      }),
    ).toBeNull();
    const trimmed = planFit({
      events: log.events,
      request,
      model: wide,
      maxOutputTokens: 5_000,
      reserveTokens: 500,
      estimate,
    }) as FitPlan;
    expect(trimmed.truncated).toHaveLength(1);
    const fitted = applyFit(request, trimmed);
    expect(estimateTokens(fitted.messages, fitted.system, fitted.tools)).toBeLessThanOrEqual(
      fitTargetOf(wide.contextWindow, 5_000, 500, estimate),
    );
  });
});

/** The target planFit uses for `estimate` (clamped output and effective reserve). */
const fitTargetOf = (window: number, output: number, reserve: number, estimate: number): number => {
  const clamped = clampOutput(window, output, estimate);
  return window - clamped - effectiveReserve(window, clamped, reserve);
};

describe("planFit", () => {
  it("returns null when the request already fits", () => {
    const log = new Log();
    log.user("hi");
    const { request, estimate } = build(log);
    expect(
      planFit({
        events: log.events,
        request,
        model: MODEL_FIT,
        maxOutputTokens: OUTPUT,
        reserveTokens: 0,
        estimate,
      }),
    ).toBeNull();
    expect(plan(log, request, estimate, estimate)).toBeNull();
    expect(plan(log, request, estimate, estimate + 10)).toBeNull();
  });

  it("drops the oldest tool pair first, then assistant text", () => {
    const log = new Log();
    log.user("question one");
    log.assistant("answer one");
    log.user("question two");
    log.assistant([{ type: "tool_call", id: "c1", name: "echo", input: {} }], "tool_use");
    log.add({
      type: "tool_result",
      payload: {
        step: 0,
        callId: "c1",
        toolKey: "echo",
        content: "result one ".repeat(40),
        isError: false,
      },
    });
    log.user("question three");
    log.assistant("answer three");
    log.user("latest");
    const { request, estimate } = build(log);
    // messages: 0 q1, 1 a1, 2 q2, 3 call, 4 result, 5 q3, 6 a3, 7 latest
    expect(request.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
      "user",
    ]);

    // enough room for one drop only: the tool pair (message 3 with its result message 4)
    const target = estimate - tokens(request.messages[3] as ModelMessage);
    const one = plan(log, request, estimate, target);
    expect(one).toEqual({ droppedMessageIndexes: [3, 4], truncated: [] });
    expect(estimateAfterFit(request, estimate, one as FitPlan)).toBeLessThanOrEqual(
      fitTargetOf(WINDOW, OUTPUT, reserveFor(target), estimate),
    );
    expect(pairsIntact(applyFit(request, one as FitPlan).messages)).toBe(true);

    // room for the pair and the oldest assistant text, not the second one
    const target2 =
      estimate -
      tokens(request.messages[3] as ModelMessage) -
      tokens(request.messages[4] as ModelMessage) -
      tokens(request.messages[1] as ModelMessage) +
      1;
    expect(plan(log, request, estimate, target2)).toEqual({
      droppedMessageIndexes: [3, 4, 1],
      truncated: [],
    });
  });

  it("never splits a tool call from its result", () => {
    const log = new Log();
    log.user("question one");
    log.assistant([{ type: "tool_call", id: "c1", name: "echo", input: {} }], "tool_use");
    log.add({
      type: "tool_result",
      payload: {
        step: 0,
        callId: "c1",
        toolKey: "echo",
        content: "result ".repeat(200),
        isError: false,
      },
    });
    log.user("latest");
    const { request, estimate } = build(log);
    // messages: 0 q1, 1 call, 2 result, 3 latest
    const trimmed = plan(log, request, estimate, estimate - 1) as FitPlan;
    expect(trimmed.droppedMessageIndexes).toEqual([1, 2]);
    expect(pairsIntact(applyFit(request, trimmed).messages)).toBe(true);
    // the older typed turn stays (only the tail keeps its turn)
    expect(applyFit(request, trimmed).messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("never drops the compaction summary", () => {
    const log = new Log();
    log.user("old question");
    log.assistant("old answer");
    log.summary(2, "Earlier: the old question was answered.");
    log.user("middle question");
    log.assistant("middle answer");
    log.user("latest");
    const { request, estimate } = build(log);
    // messages: 0 summary, 1 q, 2 a, 3 latest
    expect(request.messages[0]?.role).toBe("user");
    const trimmed = applyFit(request, plan(log, request, estimate, 1) as FitPlan);
    expect(JSON.stringify(trimmed.messages[0])).toContain("<conversation_summary>");
  });

  it("truncates the largest text block of the latest turn and inserts the note", () => {
    const log = new Log();
    log.user(`a huge latest message ${"word ".repeat(2_000)}`);
    const { request, estimate } = build(log);
    const target = estimate - 100;
    const trimmed = plan(log, request, estimate, target) as FitPlan;
    expect(trimmed.droppedMessageIndexes).toEqual([]);
    expect(trimmed.truncated).toHaveLength(1);
    expect(trimmed.truncated[0]).toMatchObject({
      messageIndex: 0,
      block: 0,
      note: FIT_TRUNCATION_NOTE,
    });
    const fitted = applyFit(request, trimmed);
    const first = fitted.messages[0] as { content: { type: string; text?: string }[] };
    expect(first.content[0]?.text).toBe(FIT_TRUNCATION_NOTE);
    expect(estimateAfterFit(request, estimate, trimmed)).toBeLessThanOrEqual(target);
  });

  it("truncates tool results in the latest turn", () => {
    const log = new Log();
    log.user("run it");
    log.assistant([{ type: "tool_call", id: "c1", name: "echo", input: {} }], "tool_use");
    log.add({
      type: "tool_result",
      payload: {
        step: 0,
        callId: "c1",
        toolKey: "echo",
        content: "tool output ".repeat(500),
        isError: false,
      },
    });
    // messages: 0 run it, 1 call, 2 result
    const { request, estimate } = build(log);
    const trimmed = plan(log, request, estimate, estimate - 100) as FitPlan;
    expect(trimmed.truncated).toHaveLength(1);
    expect(trimmed.truncated[0]).toMatchObject({ messageIndex: 2, block: 0 });
    const result = applyFit(request, trimmed).messages[2] as {
      content: { type: string; callId?: string; content?: string }[];
    };
    expect(result.content[0]).toMatchObject({ type: "tool_result", callId: "c1" });
    expect(result.content[0]?.content).toBe(FIT_TRUNCATION_NOTE);
  });

  it("is deterministic: the same input produces the same plan", () => {
    const log = new Log();
    log.user("question one");
    log.assistant("answer one ".repeat(50));
    log.user("question two");
    log.assistant([{ type: "tool_call", id: "c1", name: "echo", input: {} }], "tool_use");
    log.add({
      type: "tool_result",
      payload: {
        step: 0,
        callId: "c1",
        toolKey: "echo",
        content: "result ".repeat(100),
        isError: false,
      },
    });
    log.user("latest");
    const { request, estimate } = build(log);
    const target = estimate - 600;
    const first = plan(log, request, estimate, target);
    expect(first).not.toBeNull();
    expect(plan(log, request, estimate, target)).toEqual(first);
  });

  it("a request the droppable content cannot bring under the target keeps the whole tail", () => {
    // system + the latest turn alone exceed the target: nothing else is droppable, and truncating
    // the latest text still leaves it over — the caller raises run.context_too_large
    const log = new Log();
    log.user("latest message that is small");
    const { request, estimate } = build(log);
    const systemTokens = estimate - tokens(request.messages[0] as ModelMessage);
    const target = systemTokens - 1;
    const trimmed = plan(log, request, estimate, target) as FitPlan;
    expect(estimateAfterFit(request, estimate, trimmed)).toBeGreaterThan(
      fitTargetOf(WINDOW, OUTPUT, reserveFor(target), estimate),
    );
    expect(applyFit(request, trimmed).messages).toHaveLength(1);
  });
});
