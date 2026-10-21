import type { ModelUsage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type {
  ConversationEvent,
  ConversationEventBody,
  EventPayload,
} from "../../src/conversations/events.js";
import { buildTrajectory } from "../../src/evals/trajectory.js";
import { costOf, type ModelPrice, type PriceTable, priceKey } from "../../src/models/prices.js";

const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();

/** 按顺序编号的事件构造器：`e(ms, runId, body)`。 */
function log() {
  const events: ConversationEvent[] = [];
  const e = (ms: number, runId: string | null, body: ConversationEventBody) => {
    events.push({
      ...body,
      conversationId: "conv-1",
      seq: events.length + 1,
      runId,
      createdAt: at(ms),
    } as ConversationEvent);
  };
  return { events, e };
}

const request = (over: Partial<EventPayload<"model_call">["request"]> = {}) => ({
  fromSeq: 1,
  toSeq: 2,
  summarySeq: null,
  systemHash: "sys",
  reminderSeqs: [],
  ...over,
});

const usage = (input: number, output: number, read = 0, write = 0): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});

const PRICE_M1: ModelPrice = {
  provider: "p",
  model: "m1",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};
const PRICE_M2: ModelPrice = {
  provider: "p",
  model: "m2",
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: null,
  cacheWritePerMTok: null,
};
const table = (...ps: ModelPrice[]): PriceTable =>
  new Map(ps.map((p) => [priceKey(p.provider, p.model), p]));

const U0 = usage(1000, 200, 500, 100);
const U1 = usage(2000, 50, 0, 0);

/** 一次运行：第 0 步主模型失败 + 兜底成功，调用一个需审批的工具和 ask_user；第 1 步收尾。 */
function scenario() {
  const { events, e } = log();
  e(0, null, {
    type: "user_message",
    payload: { content: [{ type: "text", text: "hi" }], authorAccountId: "acc-1" },
  });
  e(10, "r1", {
    type: "run_started",
    payload: {
      agentVersion: 3,
      model: { provider: "p", model: "m1" },
      triggerAccountId: "acc-1",
    },
  });
  e(100, "r1", {
    type: "model_call",
    payload: {
      step: 0,
      attempt: 0,
      provider: "p",
      model: "m1",
      fallback: false,
      request: request(),
    },
  });
  e(300, "r1", {
    type: "model_call",
    payload: {
      step: 0,
      attempt: 1,
      provider: "p",
      model: "m2",
      fallback: true,
      request: request({ maxOutputTokens: 1024 }),
    },
  });
  e(1300, "r1", {
    type: "assistant_message",
    payload: {
      step: 0,
      content: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "Let me " },
        { type: "text", text: "check." },
        { type: "tool_call", id: "c1", name: "lookup", input: { q: 1 } },
        { type: "tool_call", id: "c2", name: "ask_user", input: { question: "Which?" } },
      ],
      stopReason: "tool_use",
    },
  });
  e(1300, "r1", { type: "usage", payload: { step: 0, provider: "p", model: "m2", ...U0 } });
  e(1400, "r1", {
    type: "approval_requested",
    payload: { step: 0, callId: "c1", approvalId: "ap1", toolKey: "lookup", expiresAt: iso(9e6) },
  });
  e(2400, "r1", {
    type: "approval_decided",
    payload: {
      approvalId: "ap1",
      callId: "c1",
      decision: "approved",
      scope: "once",
      byAccountId: "acc-2",
    },
  });
  e(2500, "r1", {
    type: "tool_call_started",
    payload: { step: 0, callId: "c1", toolKey: "lookup", specHash: "h1" },
  });
  e(2750, "r1", {
    type: "tool_result",
    payload: { step: 0, callId: "c1", toolKey: "lookup", content: "42", isError: false },
  });
  e(2800, "r1", {
    type: "tool_call_started",
    payload: { step: 0, callId: "c2", toolKey: "ask_user", specHash: "h2" },
  });
  e(2810, "r1", {
    type: "question_asked",
    payload: {
      step: 0,
      callId: "c2",
      questionId: "q1",
      form: { title: "Which?", fields: [] },
      expiresAt: iso(9e6),
    },
  });
  e(5000, "r1", {
    type: "question_answered",
    payload: {
      questionId: "q1",
      callId: "c2",
      answer: { pick: "a" },
      byAccountId: "acc-1",
      outcome: "answered",
    },
  });
  e(5010, "r1", {
    type: "tool_call_started",
    payload: { step: 0, callId: "c2", toolKey: "ask_user", specHash: "h2" },
  });
  e(5020, "r1", {
    type: "tool_result",
    payload: {
      step: 0,
      callId: "c2",
      toolKey: "ask_user",
      content: "pick: a",
      isError: false,
      outputId: "out-1",
    },
  });
  e(5100, "r1", {
    type: "model_call",
    payload: {
      step: 1,
      attempt: 0,
      provider: "p",
      model: "m1",
      fallback: false,
      request: request(),
    },
  });
  e(5600, "r1", {
    type: "assistant_message",
    payload: { step: 1, content: [{ type: "text", text: "Done" }], stopReason: "end_turn" },
  });
  e(5600, "r1", { type: "usage", payload: { step: 1, provider: "p", model: "m1", ...U1 } });
  e(5700, "r1", {
    type: "run_finished",
    payload: { reason: "completed", consumedUpToSeq: 1 },
  });
  return events;
}

describe("costOf", () => {
  it("按每百万 token 计价；没有价格 → null", () => {
    expect(costOf(U1, PRICE_M1)).toBeCloseTo((2000 * 3 + 50 * 15) / 1e6, 12);
    expect(costOf(U0, PRICE_M1)).toBeCloseTo(
      (1000 * 3 + 200 * 15 + 500 * 0.3 + 100 * 3.75) / 1e6,
      12,
    );
    expect(costOf(U1, undefined)).toBeNull();
  });

  it("缓存价为 null 时按输入价", () => {
    expect(costOf(U0, PRICE_M2)).toBeCloseTo((1000 + 200 * 5 + 500 + 100) / 1e6, 12);
  });
});

describe("buildTrajectory", () => {
  it("失败尝试 + 兜底成功、需审批的工具、ask_user：延迟、审批链与成本", () => {
    const runs = buildTrajectory(scenario(), table(PRICE_M1, PRICE_M2));
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error("no run");
    expect(run).toMatchObject({
      runId: "r1",
      agentVersion: 3,
      triggerAccountId: "acc-1",
      startedAt: iso(10),
      endedAt: iso(5700),
      end: { kind: "finished", detail: "completed" },
    });
    expect(run.steps.map((s) => s.step)).toEqual([0, 1]);
    const [s0, s1] = run.steps;
    if (!s0 || !s1) throw new Error("missing steps");

    // 第 0 步：主模型失败（后无 usage），兜底成功
    expect(s0.modelCalls).toHaveLength(2);
    expect(s0.modelCalls[0]).toMatchObject({
      seq: 3,
      step: 0,
      attempt: 0,
      provider: "p",
      model: "m1",
      fallback: false,
      startedAt: iso(100),
      latencyMs: null,
      outcome: "failed",
      usage: null,
      cost: null,
    });
    const ok = s0.modelCalls[1];
    expect(ok).toMatchObject({
      seq: 4,
      attempt: 1,
      model: "m2",
      fallback: true,
      outcome: "ok",
      latencyMs: 1000,
      usage: U0,
    });
    expect(ok?.request.maxOutputTokens).toBe(1024);
    expect(ok?.cost).toBeCloseTo(costOf(U0, PRICE_M2) ?? Number.NaN, 12);
    expect(s0.text).toBe("Let me check.");
    expect(s0.stopReason).toBe("tool_use");

    // 工具调用：input 取自 assistant_message 的 tool_call 块；耗时 = tool_result − tool_call_started
    expect(s0.toolCalls.map((t) => t.callId)).toEqual(["c1", "c2"]);
    const [c1, c2] = s0.toolCalls;
    expect(c1).toEqual({
      callId: "c1",
      step: 0,
      toolKey: "lookup",
      input: { q: 1 },
      startedAt: iso(2500),
      durationMs: 250,
      result: { content: "42", isError: false },
      approval: {
        approvalId: "ap1",
        requestedAt: iso(1400),
        decision: "approved",
        scope: "once",
        byAccountId: "acc-2",
        decidedAt: iso(2400),
      },
      question: null,
    });
    expect(c2).toMatchObject({
      callId: "c2",
      toolKey: "ask_user",
      input: { question: "Which?" },
      // 输入请求之后再次执行：耗时只算产出结果的那次执行
      durationMs: 10,
      result: { content: "pick: a", isError: false, outputId: "out-1" },
      approval: null,
      question: { questionId: "q1", askedAt: iso(2810), outcome: "answered", byAccountId: "acc-1" },
    });

    expect(s1.modelCalls).toHaveLength(1);
    expect(s1.modelCalls[0]).toMatchObject({ outcome: "ok", latencyMs: 500, usage: U1 });
    expect(s1.text).toBe("Done");
    expect(s1.stopReason).toBe("end_turn");
    expect(s1.toolCalls).toEqual([]);

    expect(run.totals.usage).toEqual(usage(3000, 250, 500, 100));
    expect(run.totals.modelCalls).toBe(3);
    expect(run.totals.toolCalls).toBe(2);
    expect(run.totals.durationMs).toBe(5690);
    const expected = (costOf(U0, PRICE_M2) ?? 0) + (costOf(U1, PRICE_M1) ?? 0);
    expect(run.totals.cost).toBeCloseTo(expected, 12);
  });

  it("没有价格：每次调用与合计的 cost 都是 null；部分有价也算不出合计", () => {
    const none = buildTrajectory(scenario(), new Map());
    const run = none[0];
    expect(run?.totals.cost).toBeNull();
    for (const s of run?.steps ?? []) for (const c of s.modelCalls) expect(c.cost).toBeNull();
    const partial = buildTrajectory(scenario(), table(PRICE_M1))[0];
    expect(partial?.steps[1]?.modelCalls[0]?.cost).not.toBeNull();
    expect(partial?.totals.cost).toBeNull();
  });

  it("拒绝的审批、超时的提问、失败与进行中的运行", () => {
    const { events, e } = log();
    e(0, "r1", {
      type: "run_started",
      payload: { agentVersion: 1, model: { provider: "p", model: "m1" }, triggerAccountId: "a" },
    });
    e(10, "r1", {
      type: "model_call",
      payload: {
        step: 0,
        attempt: 0,
        provider: "p",
        model: "m1",
        fallback: false,
        request: request(),
      },
    });
    e(20, "r1", {
      type: "assistant_message",
      payload: {
        step: 0,
        content: [
          { type: "tool_call", id: "x", name: "danger", input: {} },
          { type: "tool_call", id: "y", name: "ask_user", input: {} },
        ],
        stopReason: "tool_use",
      },
    });
    e(20, "r1", { type: "usage", payload: { step: 0, provider: "p", model: "m1", ...U1 } });
    e(30, "r1", {
      type: "approval_requested",
      payload: { step: 0, callId: "x", approvalId: "apx", toolKey: "danger", expiresAt: iso(1) },
    });
    e(40, "r1", {
      type: "approval_decided",
      payload: { approvalId: "apx", callId: "x", decision: "denied", byAccountId: "boss" },
    });
    e(41, "r1", {
      type: "tool_result",
      payload: { step: 0, callId: "x", toolKey: "danger", content: "denied", isError: true },
    });
    e(50, "r1", {
      type: "tool_call_started",
      payload: { step: 0, callId: "y", toolKey: "ask_user", specHash: "h" },
    });
    e(51, "r1", {
      type: "question_asked",
      payload: {
        step: 0,
        callId: "y",
        questionId: "qy",
        form: { title: "?", fields: [] },
        expiresAt: iso(1),
      },
    });
    e(60, "r1", {
      type: "question_answered",
      payload: {
        questionId: "qy",
        callId: "y",
        answer: null,
        byAccountId: null,
        outcome: "expired",
      },
    });
    e(70, "r1", {
      type: "model_call",
      payload: {
        step: 1,
        attempt: 0,
        provider: "p",
        model: "m1",
        fallback: false,
        request: request(),
      },
    });
    e(80, "r1", {
      type: "run_failed",
      payload: { error: { code: "model.overloaded", message: "busy" } },
    });
    // 第二轮：还在进行中
    e(100, "r2", {
      type: "run_started",
      payload: { agentVersion: 2, model: { provider: "p", model: "m1" }, triggerAccountId: "b" },
    });
    e(110, "r2", {
      type: "model_call",
      payload: {
        step: 0,
        attempt: 0,
        provider: "p",
        model: "m1",
        fallback: false,
        request: request(),
      },
    });
    // 从未开始的运行（排队时被中止）不出现
    e(120, "r3", { type: "run_aborted", payload: { byAccountId: "b", reason: "user" } });

    const runs = buildTrajectory(events, table(PRICE_M1));
    expect(runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    const [r1, r2] = runs;
    expect(r1?.end).toEqual({ kind: "failed", detail: "model.overloaded" });
    expect(r1?.endedAt).toBe(iso(80));
    const [x, y] = r1?.steps[0]?.toolCalls ?? [];
    expect(x).toMatchObject({
      toolKey: "danger",
      startedAt: null,
      durationMs: null,
      result: { content: "denied", isError: true },
      approval: { decision: "denied", byAccountId: "boss", decidedAt: iso(40) },
    });
    expect(x?.approval?.scope).toBeUndefined();
    expect(y).toMatchObject({
      result: null,
      durationMs: null,
      question: { questionId: "qy", outcome: "expired", byAccountId: null },
    });
    expect(r1?.steps[1]?.modelCalls[0]).toMatchObject({ outcome: "failed", usage: null });
    expect(r1?.steps[1]?.text).toBe("");
    expect(r1?.steps[1]?.stopReason).toBeNull();

    expect(r2).toMatchObject({ agentVersion: 2, endedAt: null, end: null });
    expect(r2?.totals.durationMs).toBeNull();
    expect(r2?.steps[0]?.modelCalls[0]).toMatchObject({ outcome: "pending", latencyMs: null });
    // 没有成功调用：合计成本为 0（没有需要定价的用量）
    expect(r2?.totals.cost).toBe(0);
  });

  it("中止：被中止的步骤没有 usage，按失败计；end 为 aborted", () => {
    const { events, e } = log();
    e(0, "r1", {
      type: "run_started",
      payload: { agentVersion: 1, model: { provider: "p", model: "m1" }, triggerAccountId: "a" },
    });
    e(10, "r1", {
      type: "model_call",
      payload: {
        step: 0,
        attempt: 0,
        provider: "p",
        model: "m1",
        fallback: false,
        request: request(),
      },
    });
    e(20, "r1", {
      type: "assistant_message",
      payload: { step: 0, content: [{ type: "text", text: "par" }], stopReason: "aborted" },
    });
    e(30, "r1", { type: "run_aborted", payload: { byAccountId: "a", reason: "user" } });
    const [run] = buildTrajectory(events, new Map());
    expect(run?.end).toEqual({ kind: "aborted", detail: "user" });
    expect(run?.steps[0]?.modelCalls[0]?.outcome).toBe("failed");
    expect(run?.steps[0]?.text).toBe("par");
    expect(run?.steps[0]?.stopReason).toBe("aborted");
  });
});
