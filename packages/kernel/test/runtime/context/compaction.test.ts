import { describe, expect, it } from "vitest";
import {
  acceptSummary,
  buildCompactionRequest,
  COMPACTION_MARKER,
  compactionBackoff,
  compactionPlan,
  shouldCompact,
} from "../../../src/runtime/context/compaction.js";
import { Log, MODEL } from "./fixtures.js";

describe("shouldCompact", () => {
  it("triggers at threshold × context window", () => {
    // contextWindow 10_000 × 0.8 = 8000
    expect(shouldCompact(7999, MODEL, 0.8)).toBe(false);
    expect(shouldCompact(8000, MODEL, 0.8)).toBe(true);
    expect(shouldCompact(9000, MODEL, 0.8)).toBe(true);
  });
});

describe("compactionPlan", () => {
  it("keeps the most recent 4 turns and transcribes the earlier ones", () => {
    const log = new Log();
    for (let i = 1; i <= 6; i++) log.turn(i);
    const plan = compactionPlan(log.events, 4);
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
    expect(compactionPlan(log.events, 4)).toBeNull();
    expect(compactionPlan([], 4)).toBeNull();
  });

  it("returns null when the older part has no message content", () => {
    const log = new Log();
    log.runStarted();
    for (let i = 1; i <= 4; i++) log.turn(i);
    expect(compactionPlan(log.events, 4)).toBeNull();
  });

  it("builds on the previous summary and skips what it already covers", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    log.summary(2, "Earlier: question one was answered.");
    for (let i = 3; i <= 7; i++) log.turn(i);
    const plan = compactionPlan(log.events, 4);
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
