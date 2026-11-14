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
  fitTargetFor,
  planFit,
  planSqueezedFit,
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

describe("clampOutput / effectiveReserve / fitTargetFor", () => {
  it("clampOutput lowers the cap so input + output fits the window, and keeps at least one token", () => {
    expect(clampOutput(1_000, 5_000, 200)).toBe(800);
    expect(clampOutput(1_000, 5_000, 999)).toBe(1);
    // arithmetic only: the guard clamps from the post-fit estimate, never from an input over W
    expect(clampOutput(1_000, 5_000, 1_200)).toBe(1);
    // a cap that fits the window is unchanged
    expect(clampOutput(10_000, 1_000, 200)).toBe(1_000);
  });

  it("keeps the reserve only when the output leaves room below the window", () => {
    // W - O' - 1 = 8_999, so the configured 8_000 is kept
    expect(effectiveReserve(10_000, 1_000, 8_000)).toBe(8_000);
    // W - O' - 1 = 199, so the configured 8_000 is reduced to 199
    expect(effectiveReserve(1_000, 800, 8_000)).toBe(199);
    expect(effectiveReserve(1_000, 999, 8_000)).toBe(0);
  });

  it("fitTargetFor bounds the output by the window only, never by the input", () => {
    expect(fitTargetFor(10_000, 1_000, 8_000)).toEqual({
      output: 1_000,
      reserve: 8_000,
      target: 1_000,
    });
    // O1 = min(O, W - 1); R_eff = what O1 leaves
    expect(fitTargetFor(1_000, 5_000, 8_000)).toEqual({ output: 999, reserve: 0, target: 1 });
    expect(fitTargetFor(1_000, 800, 8_000)).toEqual({ output: 800, reserve: 199, target: 1 });
    expect(fitTargetFor(4_000, 1_000, 500)).toEqual({ output: 1_000, reserve: 500, target: 2_500 });
    // at least one output token
    expect(fitTargetFor(1, 1_000, 0).output).toBe(1);
  });

  it("a request over the window is planned against W - O1 - R_eff, so the cap sent stays O1", () => {
    const log = new Log();
    log.user("question one");
    log.assistant("answer one ".repeat(400));
    log.user("question two");
    log.assistant("answer two ".repeat(400));
    log.user(`latest ${"word ".repeat(400)}`);
    const { request, estimate } = build(log);
    const small: ModelInfo = { ...MODEL_FIT, contextWindow: 2_000 };
    const { output, target } = fitTargetFor(small.contextWindow, 1_000, 500);
    expect(estimate).toBeGreaterThan(small.contextWindow);
    const trimmed = planFit({
      events: log.events,
      request,
      model: small,
      maxOutputTokens: 1_000,
      reserveTokens: 500,
      estimate,
    }) as FitPlan;
    expect(trimmed).not.toBeNull();
    const after = estimateAfterFit(request, estimate, trimmed);
    expect(after).toBeLessThanOrEqual(target);
    // the caller clamps after the plan, from the post-fit estimate: the full cap, not 1
    expect(clampOutput(small.contextWindow, output, after)).toBe(1_000);
    const fitted = applyFit(request, trimmed);
    expect(estimateTokens(fitted.messages, fitted.system, fitted.tools)).toBeLessThanOrEqual(
      target,
    );
  });
});

describe("planSqueezedFit (the target is out of reach)", () => {
  it("a window about the size of the output cap plans against the output the input leaves", () => {
    const log = new Log();
    log.user("question one");
    log.assistant("answer one ".repeat(100));
    log.user("latest");
    const { request, estimate } = build(log);
    // W 2000, O 4096, R 0: O1 = 1999 leaves a target of 1, which no plan reaches
    const small: ModelInfo = { ...MODEL_FIT, contextWindow: 2_000 };
    const input = {
      events: log.events,
      request,
      model: small,
      maxOutputTokens: 4_096,
      reserveTokens: 0,
      estimate,
    };
    const unreachable = planFit(input) as FitPlan;
    expect(estimateAfterFit(request, estimate, unreachable)).toBeGreaterThan(1);
    // squeezed: the output takes what the input leaves, so the request fits as it is
    expect(planSqueezedFit(input)).toEqual({ plan: null, target: estimate });
    expect(clampOutput(small.contextWindow, 1_999, estimate)).toBe(2_000 - estimate);
  });

  it("with a reserve, the squeezed plan trims to W - O_sq - R_eff", () => {
    const log = new Log();
    log.user("question one");
    log.assistant("answer one ".repeat(100));
    log.user("latest");
    const { request, estimate } = build(log);
    const small: ModelInfo = { ...MODEL_FIT, contextWindow: 2_000 };
    const squeezed = planSqueezedFit({
      events: log.events,
      request,
      model: small,
      maxOutputTokens: 4_096,
      reserveTokens: 100,
      estimate,
    });
    expect(squeezed.target).toBe(estimate - 100);
    expect(squeezed.plan?.droppedMessageIndexes).toEqual([1]);
    expect(estimateAfterFit(request, estimate, squeezed.plan as FitPlan)).toBeLessThanOrEqual(
      squeezed.target,
    );
  });
});

/** The target planFit uses (output bounded by the window, effective reserve). */
const fitTargetOf = (window: number, output: number, reserve: number): number =>
  fitTargetFor(window, output, reserve).target;

/** A tool pair in the log: the assistant's call and its result. */
function pair(log: Log, id: string, size: number): void {
  log.assistant([{ type: "tool_call", id, name: "echo", input: {} }], "tool_use");
  log.add({
    type: "tool_result",
    payload: {
      step: 0,
      callId: id,
      toolKey: "echo",
      content: `result ${id} `.padEnd(size * 4, "r"),
      isError: false,
    },
  });
}

describe("planFit inside the latest user turn", () => {
  it("drops the turn's tool pairs oldest first, keeping the typed message and the latest pair", () => {
    const log = new Log();
    log.user("the task");
    pair(log, "a", 300);
    pair(log, "b", 300);
    pair(log, "c", 300);
    const { request, estimate } = build(log);
    // messages: 0 task, 1 call a, 2 result a, 3 call b, 4 result b, 5 call c, 6 result c
    expect(request.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const pairA =
      tokens(request.messages[1] as ModelMessage) + tokens(request.messages[2] as ModelMessage);
    // room for dropping pair A only
    const one = plan(log, request, estimate, estimate - pairA) as FitPlan;
    expect(one).toEqual({ droppedMessageIndexes: [1, 2], truncated: [] });
    // room only after dropping A and B: C (the latest pair) and the task stay
    const two = plan(log, request, estimate, estimate - pairA - 1) as FitPlan;
    expect(two.droppedMessageIndexes).toEqual([1, 2, 3, 4]);
    const fitted = applyFit(request, two);
    expect(pairsIntact(fitted.messages)).toBe(true);
    expect(JSON.stringify(fitted.messages[0])).toContain("the task");
    expect(JSON.stringify(fitted.messages)).toContain("result c");
    // far over: the pairs before the latest go, then the kept tail is truncated; C is never dropped
    const all = plan(log, request, estimate, 1) as FitPlan;
    expect(all.droppedMessageIndexes).toEqual([1, 2, 3, 4]);
    expect(pairsIntact(applyFit(request, all).messages)).toBe(true);
  });

  it("drops older turns before the latest turn's pairs", () => {
    const log = new Log();
    log.user("old question");
    log.assistant("old answer ".repeat(100));
    log.user("the task");
    pair(log, "a", 300);
    pair(log, "b", 300);
    const { request, estimate } = build(log);
    // messages: 0 old q, 1 old a, 2 task, 3 call a, 4 result a, 5 call b, 6 result b
    const trimmed = plan(
      log,
      request,
      estimate,
      estimate -
        tokens(request.messages[1] as ModelMessage) -
        tokens(request.messages[0] as ModelMessage) -
        1,
    ) as FitPlan;
    expect(trimmed.droppedMessageIndexes).toEqual([1, 0, 3, 4]);
  });

  it("does not treat the summary as the latest user turn when it covers the typed message", () => {
    const log = new Log();
    const task = log.user("the task");
    pair(log, "a", 300);
    log.summary(task.seq + 2, "Earlier: the user asked for the task; call a ran.");
    pair(log, "b", 300);
    pair(log, "c", 300);
    pair(log, "d", 300);
    const { request, estimate } = build(log);
    // messages: 0 summary, 1 call b, 2 result b, 3 call c, 4 result c, 5 call d, 6 result d
    expect(JSON.stringify(request.messages[0])).toContain("<conversation_summary>");
    expect(request.messages).toHaveLength(7);
    const trimmed = plan(log, request, estimate, 1) as FitPlan;
    expect(trimmed.droppedMessageIndexes).toEqual([1, 2, 3, 4]);
    const fitted = applyFit(request, trimmed);
    expect(JSON.stringify(fitted.messages[0])).toContain("<conversation_summary>");
    // the latest pair (d) is kept, truncated at most
    expect(JSON.stringify(fitted.messages)).toContain('"callId":"d"');
    expect(fitted.messages).toHaveLength(3);
    expect(pairsIntact(fitted.messages)).toBe(true);
    // the summary is never truncated
    expect(trimmed.truncated.every((t) => t.messageIndex !== 0)).toBe(true);
  });

  it("truncates a huge re-rendered opening message after the summary, never the summary text", () => {
    const log = new Log();
    const task = log.user(`the task ${"t".repeat(40_000)}`);
    log.runStarted();
    pair(log, "a", 300);
    log.summary(task.seq + 3, "Earlier: the user asked for the task; call a ran.");
    pair(log, "b", 300);
    pair(log, "c", 300);
    const { request, estimate } = build(log);
    // messages: 0 summary (block 0 the summary text, block 1 the opening message), 1 call b,
    // 2 result b, 3 call c, 4 result c
    const summary = request.messages[0] as ModelMessage;
    expect(summary.content).toHaveLength(2);
    expect(JSON.stringify(summary.content[0])).toContain("<conversation_summary>");
    expect(JSON.stringify(summary.content[1])).toContain("the task ttt");
    // room for the summary text, the latest pair and little else: the opening message must go
    const target = estimate - 9_000;
    const trimmed = plan(log, request, estimate, target) as FitPlan;
    expect(trimmed.truncated).toContainEqual({
      messageIndex: 0,
      block: 1,
      note: FIT_TRUNCATION_NOTE,
    });
    expect(trimmed.truncated).not.toContainEqual(expect.objectContaining({ block: 0 }));
    expect(estimateAfterFit(request, estimate, trimmed)).toBeLessThanOrEqual(target);
    const fitted = applyFit(request, trimmed);
    expect(JSON.stringify(fitted.messages[0])).toContain("Earlier: the user asked for the task");
    expect(JSON.stringify(fitted.messages)).not.toContain("tttttttttt");
    expect(pairsIntact(fitted.messages)).toBe(true);
  });
});

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
      fitTargetOf(WINDOW, OUTPUT, reserveFor(target)),
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
      fitTargetOf(WINDOW, OUTPUT, reserveFor(target)),
    );
    expect(applyFit(request, trimmed).messages).toHaveLength(1);
  });
});
