import type { ModelInfo, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildModelRequest } from "../../../src/runtime/context/build.js";
import {
  compactionPlan,
  openingSeqs,
  shouldCompact,
} from "../../../src/runtime/context/compaction.js";
import { applyFit, planFit, planningBounds } from "../../../src/runtime/context/fit.js";
import { estimateTokens } from "../../../src/runtime/context/tokens.js";
import { AGENT, compactionSettings, Log, MODEL } from "./fixtures.js";

/**
 * End to end over the pure pieces the runtime chains before a step (context compaction spec §4.2,
 * revision 2026-11-15): one user message followed by a long tool loop that outgrows the window. The
 * trigger fires, the plan summarises, the summary is logged, the next request is built and the hard
 * fit guard plans what still does not fit. The assertions pin what the model actually sees.
 */

/** A 10k window with a 1k output cap and a 500-token reserve. */
const MODEL_10K: ModelInfo = { ...MODEL, contextWindow: 10_000, maxOutputTokens: 1_000 };
const SETTINGS = compactionSettings({ reserveTokens: 500, maxOutputTokens: 1_000 });
const TASK = "task: audit every ledger file and report the mismatched totals";
const PAIRS = 30;

const build = (log: Log) =>
  buildModelRequest({
    events: log.events,
    agent: AGENT,
    agentVersion: 1,
    model: MODEL_10K,
    step: PAIRS + 1,
  }).request;

const estimate = (r: ModelRequest) => estimateTokens(r.messages, r.system, r.tools);

/** One user message, then `PAIRS` steps each reading one ledger file (≈300 tokens a result). */
function longToolLoop(): Log {
  const log = new Log();
  log.user("question 0: what is in the ledger folder?");
  log.assistant("answer 0: twelve months of ledger files.");
  log.user(TASK);
  log.runStarted();
  for (let n = 1; n <= PAIRS; n++) {
    log.assistant(
      [{ type: "tool_call", id: `call-${n}`, name: "Read", input: { path: `/ledger/${n}.csv` } }],
      "tool_use",
      n,
    );
    log.add({
      type: "tool_result",
      payload: {
        step: n,
        callId: `call-${n}`,
        toolKey: "Read",
        content: `ledger ${n}: ${"0123456789,".repeat(110)}`,
        isError: false,
      },
    });
  }
  return log;
}

/** Text of a message (text blocks and tool results), for "is it in the request" checks. */
const textOf = (m: ModelMessage): string =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
        .join("\n");

describe("compaction inside the current turn, end to end", () => {
  it("summarises the older pairs of one long user turn and keeps its user message verbatim", () => {
    const log = longToolLoop();
    const before = build(log);
    const W = MODEL_10K.contextWindow;
    const O = before.maxOutputTokens;
    // the trigger fires on this request
    expect(shouldCompact(estimate(before), W, { ...SETTINGS, maxOutputTokens: O })).toBe(true);

    const tailBudget =
      planningBounds(W, O, SETTINGS.reserveTokens).target -
      estimateTokens([], before.system, before.tools);
    const plan = compactionPlan(log.events, SETTINGS, tailBudget);
    expect(plan).not.toBeNull();
    const covers = plan?.coversUpToSeq ?? 0;
    const taskSeq = log.events.find(
      (e) =>
        e.type === "user_message" &&
        e.payload.content.some((b) => b.type === "text" && b.text === TASK),
    )?.seq;
    // the summary covers the task message and the oldest pairs of its own turn
    expect(covers).toBeGreaterThan(taskSeq ?? 0);
    expect(plan?.transcript).toContain(`User: ${TASK}`);
    expect(plan?.transcript).toContain("ledger 1:");
    // the summary records the run's opening message it covers (what the runtime writes)
    const opening = openingSeqs(log.events, "run-1", covers);
    expect(opening).toEqual([taskSeq]);
    log.summary(covers, "The agent read the oldest ledger files; no mismatch so far.", opening);

    const after = build(log);
    const fit = planFit({
      events: log.events,
      request: after,
      model: MODEL_10K,
      maxOutputTokens: O,
      reserveTokens: SETTINGS.reserveTokens,
      estimate: estimate(after),
    });
    // the summary made room: the request fits without the hard fit guard
    expect(fit).toBeNull();
    const sent = fit ? applyFit(after, fit) : after;

    // what the model sees: the summary with the task verbatim, then the kept tool pairs
    const [first, second] = sent.messages;
    expect(first?.role).toBe("user");
    expect(textOf(first as ModelMessage)).toContain("<conversation_summary>");
    expect(textOf(first as ModelMessage)).toContain(TASK);
    expect(second?.role).toBe("assistant");
    expect(
      Array.isArray(second?.content) && second.content.some((b) => b.type === "tool_call"),
    ).toBe(true);
    // every result answers a call of the message right before it; no empty message
    sent.messages.forEach((m, i) => {
      expect(typeof m.content === "string" ? m.content : m.content.length).toBeTruthy();
      if (typeof m.content === "string") return;
      const prev = sent.messages[i - 1];
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const calls =
          prev && typeof prev.content !== "string"
            ? prev.content.flatMap((c) => (c.type === "tool_call" ? [c.id] : []))
            : [];
        expect(calls).toContain(b.callId);
      }
    });
    // the latest result is kept whole
    expect(textOf(sent.messages.at(-1) as ModelMessage)).toContain(`ledger ${PAIRS}:`);
  });

  it("keepRecentTurns 0 mid-run: the next two requests share the same summary message (append-only)", () => {
    const log = longToolLoop();
    const settings = { ...SETTINGS, keepRecentTurns: 0 };
    const plan = compactionPlan(log.events, settings, 1_000_000);
    // keepRecentTurns 0 summarises everything, the run's own steps included
    const covers = plan?.coversUpToSeq ?? 0;
    expect(covers).toBe(log.events.at(-1)?.seq);
    log.summary(
      covers,
      "The agent read all ledger files so far.",
      openingSeqs(log.events, "run-1", covers),
    );
    const right = build(log);
    expect(textOf(right.messages[0] as ModelMessage)).toContain(TASK);
    // the next step: one more tool pair; the request before it is a prefix of this one
    log.assistant(
      [{ type: "tool_call", id: "call-next", name: "Read", input: { path: "/ledger/next.csv" } }],
      "tool_use",
      PAIRS + 1,
    );
    log.add({
      type: "tool_result",
      payload: {
        step: PAIRS + 1,
        callId: "call-next",
        toolKey: "Read",
        content: "next",
        isError: false,
      },
    });
    const next = build(log);
    expect(next.messages[0]).toEqual(right.messages[0]);
    expect(next.messages.slice(0, right.messages.length)).toEqual(right.messages);
  });
});
