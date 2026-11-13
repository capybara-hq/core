import { describe, expect, it } from "vitest";
import {
  acceptSummary,
  buildCompactionRequest,
  COMPACTION_MARKER,
  compactionBackoff,
  compactionInputBudget,
  compactionPlan,
  shouldCompact,
} from "../../../src/runtime/context/compaction.js";
import { Log, NO_TAIL_LIMIT as NO_LIMIT, compactionSettings as settings } from "./fixtures.js";

const WINDOW = 200_000;

describe("compactionInputBudget", () => {
  it("leaves room for the output cap and the reserve", () => {
    expect(compactionInputBudget(WINDOW, 16_000, 8_000)).toBe(176_000);
  });
});

describe("shouldCompact", () => {
  it("triggers at threshold × window when that is the lower bound", () => {
    // 0.8 × 200k = 160k, below the 176k input budget
    expect(shouldCompact(159_999, WINDOW, settings({ threshold: 0.8 }))).toBe(false);
    expect(shouldCompact(160_000, WINDOW, settings({ threshold: 0.8 }))).toBe(true);
  });

  it("a late threshold routes through the input budget (the lower of the two)", () => {
    // 0.95 × 200k = 190k, but the 16k output cap and 8k reserve leave only 176k
    expect(shouldCompact(175_999, WINDOW, settings({ threshold: 0.95 }))).toBe(false);
    expect(shouldCompact(176_000, WINDOW, settings({ threshold: 0.95 }))).toBe(true);
    expect(shouldCompact(189_999, WINDOW, settings({ threshold: 0.95 }))).toBe(true);
  });

  it("triggers on the hard line even when proactive compaction is off", () => {
    // estimate + output cap > window: 184_001 + 16_000 > 200_000
    expect(shouldCompact(184_001, WINDOW, settings({ enabled: false }))).toBe(true);
    // below the hard line, enabled: false turns proactive compaction off
    expect(shouldCompact(160_000, WINDOW, settings({ enabled: false }))).toBe(false);
  });
});

describe("compactionPlan", () => {
  it("keeps the most recent 4 turns and transcribes the earlier ones", () => {
    const log = new Log();
    for (let i = 1; i <= 6; i++) log.turn(i);
    const plan = compactionPlan(log.events, settings(), NO_LIMIT);
    // turns 1-2 are seq 1..4; turn 3 starts at seq 5
    expect(plan?.coversUpToSeq).toBe(4);
    expect(plan?.transcript).toContain("User: question 1");
    expect(plan?.transcript).toContain("Assistant: answer 1");
    expect(plan?.transcript).toContain("Assistant: answer 2");
    expect(plan?.transcript).not.toContain("question 3");
  });

  it("returns null when nothing is older than the kept turns", () => {
    const log = new Log();
    for (let i = 1; i <= 4; i++) log.turn(i);
    expect(compactionPlan(log.events, settings(), NO_LIMIT)).toBeNull();
    expect(compactionPlan([], settings(), NO_LIMIT)).toBeNull();
  });

  it("returns null when the older part has no message content", () => {
    const log = new Log();
    log.runStarted();
    for (let i = 1; i <= 4; i++) log.turn(i);
    expect(compactionPlan(log.events, settings(), NO_LIMIT)).toBeNull();
  });

  it("builds on the previous summary and skips what it already covers", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    log.summary(2, "Earlier: question one was answered.");
    for (let i = 3; i <= 7; i++) log.turn(i);
    const plan = compactionPlan(log.events, settings(), NO_LIMIT);
    expect(plan?.transcript).toContain("Earlier: question one was answered.");
    expect(plan?.transcript).not.toContain("question 1");
    expect(plan?.transcript).toContain("User: question 2");
    expect(plan?.transcript).toContain("User: question 3");
    expect(plan?.transcript).not.toContain("question 4");
    const firstKept = log.events.find(
      (e) =>
        e.type === "user_message" &&
        e.payload.content[0]?.type === "text" &&
        e.payload.content[0].text === "question 4",
    );
    expect(plan?.coversUpToSeq).toBe((firstKept?.seq ?? 0) - 1);
  });
});

describe("compactionPlan: size-aware tail", () => {
  /**
   * Six turns; a user line is `User: question N: ` + 400 chars (≈105 tokens) and an assistant
   * line `Assistant: answer N: ` + 400 chars (≈106 tokens), so one turn is ≈211 tokens.
   */
  const longLog = () => {
    const log = new Log();
    for (let i = 1; i <= 6; i++) {
      log.user(`question ${i}: ${"x".repeat(400)}`);
      log.assistant(`answer ${i}: ${"y".repeat(400)}`);
    }
    return log;
  };
  const lastUserSeq = (log: Log) => {
    const last = [...log.events].reverse().find((e) => e.type === "user_message");
    return last?.seq ?? 0;
  };

  it("keeps as many recent turns as fit, not the configured maximum", () => {
    // the configured 4 kept turns (≈844 tokens) do not fit 450; turns 5-6 (≈422) do
    const log = longLog();
    const plan = compactionPlan(log.events, settings(), 450);
    expect(plan).not.toBeNull();
    expect(plan?.transcript).toContain("question 4");
    expect(plan?.transcript).not.toContain("question 5");
  });

  it("shrinks to the latest user turn when only one turn fits", () => {
    const log = longLog();
    const plan = compactionPlan(log.events, settings(), 300);
    expect(plan).not.toBeNull();
    expect(plan?.transcript).toContain("question 5");
    expect(plan?.transcript).not.toContain("question 6");
    expect(plan?.coversUpToSeq).toBe(lastUserSeq(log) - 1);
  });

  it("keeps the latest turn even when it alone exceeds the budget, leaving the trim to the fit guard", () => {
    const log = longLog();
    const plan = compactionPlan(log.events, settings(), 50);
    expect(plan).not.toBeNull();
    expect(plan?.transcript).toContain("question 5");
    expect(plan?.transcript).not.toContain("question 6");
    expect(plan?.coversUpToSeq).toBe(lastUserSeq(log) - 1);
  });
});

describe("buildCompactionRequest", () => {
  it("carries the marker in an English system instruction and the transcript as user text", () => {
    const req = buildCompactionRequest("User: hi\n\nAssistant: hello", "fake-1");
    expect(req.model).toBe("fake-1");
    expect(req.tools).toEqual([]);
    expect(COMPACTION_MARKER).toBe("CAPYBARA_COMPACTION");
    expect(req.system[0]?.text).toContain(COMPACTION_MARKER);
    expect(req.system[0]?.text).toMatch(/summar/i);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    expect(JSON.stringify(req.messages[0])).toContain("Assistant: hello");
    expect(req.maxOutputTokens).toBeGreaterThan(0);
  });
});

describe("acceptSummary", () => {
  it("rejects summaries shorter than min(200 chars, 5% of the transcript)", () => {
    expect(acceptSummary("short", "x".repeat(10_000))).toBe(false);
    expect(acceptSummary("y".repeat(200), "x".repeat(10_000))).toBe(true);
    expect(acceptSummary("y".repeat(199), "x".repeat(10_000))).toBe(false);
    // 5% of 1000 = 50 < 200
    expect(acceptSummary("y".repeat(50), "x".repeat(1000))).toBe(true);
    expect(acceptSummary("y".repeat(49), "x".repeat(1000))).toBe(false);
  });

  it("does not count surrounding whitespace", () => {
    expect(acceptSummary(` ${"y".repeat(49)} `, "x".repeat(1000))).toBe(false);
  });
});

describe("compactionBackoff", () => {
  it("is false without failures", () => {
    const log = new Log();
    log.turn(1);
    expect(compactionBackoff(log.events)).toBe(false);
  });

  it("after 1 failure skips the next turn and allows after 2 turns", () => {
    const log = new Log();
    log.turn(1);
    log.compactionFailed(1);
    expect(compactionBackoff(log.events)).toBe(true);
    log.user("question 2");
    expect(compactionBackoff(log.events)).toBe(true);
    log.assistant("answer 2");
    log.user("question 3");
    expect(compactionBackoff(log.events)).toBe(false);
  });

  it("after 2 failures waits 4 turns", () => {
    const log = new Log();
    log.compactionFailed(2);
    for (let i = 1; i <= 3; i++) log.turn(i);
    expect(compactionBackoff(log.events)).toBe(true);
    log.user("question 4");
    expect(compactionBackoff(log.events)).toBe(false);
  });

  it("a successful summary after the failure clears the backoff", () => {
    const log = new Log();
    log.turn(1);
    log.compactionFailed(3);
    log.summary(2, "done");
    expect(compactionBackoff(log.events)).toBe(false);
  });
});
