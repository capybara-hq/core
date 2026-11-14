import { describe, expect, it } from "vitest";
import { casePlan, casePlans, textTokens } from "../../src/evals/plan.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";

/**
 * Case plans (context compaction spec §4.5 / §4.7): a compact run runs no model step, so it has
 * nothing to replay in either mode; a normal run's plan pairs each replayed call with its own
 * usage, never with a compaction call's (which may come in chunks).
 */

const T = "2026-11-14T12:00:00.000Z";

const U = { cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A case snapshot of one run, from its events (seqs and timestamps assigned in order). */
const snapshot = (runId: string, events: { type: string; payload: unknown }[]): CaseSnapshot => ({
  version: 1,
  orgId: "o1",
  conversationId: "c1",
  runId,
  agentId: "a1",
  agentVersion: 1,
  events: events.map((e, i) => ({
    seq: i + 1,
    type: e.type as CaseSnapshot["events"][number]["type"],
    payload: e.payload,
    runId,
    createdAt: new Date(Date.parse(T) + i * 1000).toISOString(),
  })),
  definitions: {},
  toolSpecs: {},
});

const request = { fromSeq: 1, toSeq: 9, summarySeq: null, systemHash: "h", reminderSeqs: [] };

const call = (step: number, seq: number) => ({
  type: "model_call",
  payload: {
    step,
    attempt: 1,
    provider: "p",
    model: "m",
    fallback: false,
    request: { ...request, absorbedUpToSeq: seq },
  },
});

const stepUsage = (step: number) => ({
  type: "usage",
  payload: { step, provider: "p", model: "m", inputTokens: 100, outputTokens: 10, ...U },
});

const reply = (step: number, text: string) => ({
  type: "assistant_message",
  payload: { step, content: [{ type: "text", text }], stopReason: "end_turn" },
});

const user = (text: string) => ({
  type: "user_message",
  payload: { content: [{ type: "text", text }], authorAccountId: "acc-1" },
});

describe("case plans", () => {
  it("a compact run has no plan in either mode: no step, nothing to replay", () => {
    const s = snapshot("r1", [
      user("hello"),
      {
        type: "run_started",
        payload: {
          agentVersion: 1,
          model: { provider: "p", model: "m" },
          triggerAccountId: "acc-1",
          trigger: "compact",
        },
      },
      {
        type: "usage",
        payload: {
          step: 0,
          provider: "p",
          model: "m",
          inputTokens: 1000,
          outputTokens: 100,
          ...U,
          purpose: "compaction",
          chunk: 1,
          chunks: 2,
        },
      },
      {
        type: "usage",
        payload: {
          step: 0,
          provider: "p",
          model: "m",
          inputTokens: 1000,
          outputTokens: 100,
          ...U,
          purpose: "compaction",
          chunk: 2,
          chunks: 2,
        },
      },
      {
        type: "compaction_summary",
        payload: { coversUpToSeq: 1, text: "summary", savedTokens: 900 },
      },
      { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 1 } },
    ]);
    const plans = casePlans(s);
    expect(plans.step).toEqual({
      results: [],
      modelRequests: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      judgeContextTokens: 0,
    });
    expect(plans.run).toEqual(plans.step);
  });

  it("a normal run's step plan pairs each replayable call with its own usage, never a compaction's chunk", () => {
    const s = snapshot("r1", [
      user("hello"),
      {
        type: "run_started",
        payload: {
          agentVersion: 1,
          model: { provider: "p", model: "m" },
          triggerAccountId: "acc-1",
        },
      },
      {
        type: "usage",
        payload: {
          step: 1,
          provider: "p",
          model: "m",
          inputTokens: 9000,
          outputTokens: 500,
          ...U,
          purpose: "compaction",
          chunk: 1,
          chunks: 1,
        },
      },
      call(1, 2),
      reply(1, "one"),
      stepUsage(1),
      call(2, 3),
      reply(2, "two"),
      stepUsage(2),
      { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 1 } },
    ]);
    const plan = casePlan(s, "step");
    expect(plan.results).toEqual([
      { step: 1, modelCallSeq: 4 },
      { step: 2, modelCallSeq: 7 },
    ]);
    expect(plan.modelRequests).toBe(2);
    // the compaction call's usage is not a replayed request's
    expect(plan.usage).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // the judge sees the user request plus both replies (estimated from the output tokens)
    expect(plan.judgeContextTokens).toBe(2 * textTokens("hello") + 2 * 20);
  });

  it("a normal run's run plan sums every usage of the run, a chunked compaction's included", () => {
    const s = snapshot("r1", [
      user("hello"),
      {
        type: "run_started",
        payload: {
          agentVersion: 1,
          model: { provider: "p", model: "m" },
          triggerAccountId: "acc-1",
        },
      },
      call(1, 2),
      reply(1, "one"),
      stepUsage(1),
      {
        type: "usage",
        payload: {
          step: 1,
          provider: "p",
          model: "m",
          inputTokens: 1000,
          outputTokens: 100,
          ...U,
          purpose: "compaction",
          chunk: 1,
          chunks: 2,
        },
      },
      {
        type: "usage",
        payload: {
          step: 1,
          provider: "p",
          model: "m",
          inputTokens: 1000,
          outputTokens: 100,
          ...U,
          purpose: "compaction",
          chunk: 2,
          chunks: 2,
        },
      },
      { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 1 } },
    ]);
    const plan = casePlan(s, "run");
    expect(plan.results).toEqual([{ step: null, modelCallSeq: null }]);
    expect(plan.modelRequests).toBe(1);
    expect(plan.usage).toEqual({
      inputTokens: 2100,
      outputTokens: 210,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
