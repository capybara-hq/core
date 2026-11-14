import { describe, expect, it } from "vitest";
import {
  acceptSummary,
  buildCompactionRequest,
  COMPACTION_MARKER,
  COMPACTION_MAX_OUTPUT_TOKENS,
  chunkTranscript,
  compactionBackoff,
  compactionChunkSize,
  compactionInputBudget,
  compactionPlan,
  compactionRequestOverhead,
  extractSummary,
  shouldCompact,
  summarySavedTokens,
} from "../../../src/runtime/context/compaction.js";
import { estimateTokens } from "../../../src/runtime/context/tokens.js";
import { Log, NO_TAIL_LIMIT as NO_LIMIT, compactionSettings as settings } from "./fixtures.js";

const WINDOW = 200_000;

/** Estimated tokens of a plain text, the unit the chunk size is expressed in. */
const textTokensOf = (text: string) =>
  estimateTokens([{ role: "user", content: [{ type: "text", text }] }], []);

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

  it("keeps a latest turn without tool pairs even when it alone exceeds the budget, leaving the trim to the fit guard", () => {
    const log = longLog();
    const plan = compactionPlan(log.events, settings(), 50);
    expect(plan).not.toBeNull();
    expect(plan?.transcript).toContain("question 5");
    expect(plan?.transcript).not.toContain("question 6");
    expect(plan?.coversUpToSeq).toBe(lastUserSeq(log) - 1);
  });
});

describe("compactionPlan: inside the latest user turn (spec §4.2, revision 2026-11-15)", () => {
  /** An assistant step calling one tool, then its result (`result N: ` + `size` chars). */
  const pair = (log: Log, n: number, size = 400, input: unknown = { n }) => {
    const call = log.assistant(
      [{ type: "tool_call", id: `call-${n}`, name: "Read", input }],
      "tool_use",
      n,
    );
    const result = log.add({
      type: "tool_result",
      payload: {
        step: n,
        callId: `call-${n}`,
        toolKey: "Read",
        content: `result ${n}: ${"y".repeat(size)}`,
        isError: false,
      },
    });
    return { call, result };
  };
  /** The first kept event of a plan: the smallest seq above `coversUpToSeq`, summaries apart. */
  const firstKept = (log: Log, coversUpToSeq: number) =>
    log.events.find((e) => e.seq > coversUpToSeq && e.type !== "compaction_summary");
  /** Every tool call's result is on the same side of the cut as the call. */
  const pairsIntact = (log: Log, coversUpToSeq: number) => {
    const at = new Map<string, number>();
    for (const e of log.events) if (e.type === "tool_result") at.set(e.payload.callId, e.seq);
    for (const e of log.events) {
      if (e.type !== "assistant_message") continue;
      for (const b of e.payload.content) {
        if (b.type !== "tool_call") continue;
        const r = at.get(b.id);
        if (r !== undefined && e.seq <= coversUpToSeq !== r <= coversUpToSeq) return false;
      }
    }
    return true;
  };

  it("cuts at a tool-pair boundary when one user turn's tool loop is over the budget", () => {
    // one user message, five pairs of ≈125 tokens: only the latest two fit 300
    const log = new Log();
    log.user("task: migrate the ledger");
    const pairs = [1, 2, 3, 4, 5].map((n) => pair(log, n));
    const plan = compactionPlan(log.events, settings(), 300);
    expect(plan).not.toBeNull();
    const covers = plan?.coversUpToSeq ?? 0;
    expect(covers).toBe((pairs[3]?.call.seq ?? 0) - 1);
    expect(plan?.transcript).toContain("User: task: migrate the ledger");
    expect(plan?.transcript).toContain("result 1:");
    expect(plan?.transcript).toContain("result 3:");
    expect(plan?.transcript).not.toContain("result 4:");
    const kept = firstKept(log, covers);
    expect(kept?.type).toBe("assistant_message");
    expect(
      kept?.type === "assistant_message" &&
        kept.payload.content.some((b) => b.type === "tool_call"),
    ).toBe(true);
    expect(pairsIntact(log, covers)).toBe(true);
  });

  it("never separates a tool call from its result across a mid-run interjection", () => {
    // the interjection arrives while call 2 runs; call 2's input is large, so the tail from the
    // interjection fits and the tail from call 2 does not, but no cut between them is allowed
    const log = new Log();
    log.user("task");
    pair(log, 1);
    const call2 = log.assistant(
      [{ type: "tool_call", id: "call-2", name: "Read", input: { pad: "z".repeat(1200) } }],
      "tool_use",
      2,
    );
    log.user("interjection: also check the totals");
    log.add({
      type: "tool_result",
      payload: { step: 2, callId: "call-2", toolKey: "Read", content: "result 2", isError: false },
    });
    const last = pair(log, 3, 40);
    const plan = compactionPlan(log.events, settings(), 200);
    expect(plan).not.toBeNull();
    const covers = plan?.coversUpToSeq ?? 0;
    expect(covers).toBeGreaterThanOrEqual(call2.seq);
    expect(covers).toBe(last.call.seq - 1);
    expect(plan?.transcript).toContain("interjection: also check the totals");
    expect(plan?.transcript).toContain("result 2");
    expect(pairsIntact(log, covers)).toBe(true);
  });

  it("covers everything before a single tool pair that alone is over the budget", () => {
    const log = new Log();
    log.user("task");
    const only = pair(log, 1, 4000);
    const plan = compactionPlan(log.events, settings(), 50);
    expect(plan?.coversUpToSeq).toBe(only.call.seq - 1);
    expect(plan?.transcript).toBe("User: task");
  });

  it("returns null when nothing precedes the single pair over the budget", () => {
    const log = new Log();
    const task = log.user("task");
    log.summary(task.seq, "They asked for a task.");
    pair(log, 1, 4000);
    expect(compactionPlan(log.events, settings(), 50)).toBeNull();
  });

  it("keeps cutting inside the turn after a summary that covers its user message", () => {
    const log = new Log();
    const task = log.user("task");
    log.summary(task.seq, "They asked for a task.");
    const pairs = [1, 2, 3, 4].map((n) => pair(log, n));
    const plan = compactionPlan(log.events, settings(), 300);
    expect(plan).not.toBeNull();
    expect(plan?.coversUpToSeq).toBe((pairs[2]?.call.seq ?? 0) - 1);
    expect(plan?.transcript.startsWith("[Earlier summary]\nThey asked for a task.")).toBe(true);
    expect(plan?.transcript).toContain("result 2:");
    expect(plan?.transcript).not.toContain("result 3:");
  });

  it("keeps the latest pair when it alone is over the budget", () => {
    const log = new Log();
    log.user("task");
    pair(log, 1);
    pair(log, 2);
    const last = pair(log, 3, 4000);
    const plan = compactionPlan(log.events, settings(), 50);
    expect(plan?.coversUpToSeq).toBe(last.call.seq - 1);
    expect(plan?.transcript).toContain("result 2:");
  });

  it("does not move inside the turn while earlier turns can still go", () => {
    // the latest turn with its pair fits; only the earlier turn is summarised
    const log = new Log();
    log.user(`question 1: ${"x".repeat(1200)}`);
    log.assistant("answer 1");
    const task = log.user("task");
    pair(log, 1, 40);
    const plan = compactionPlan(log.events, settings({ keepRecentTurns: 2 }), 300);
    expect(plan?.coversUpToSeq).toBe(task.seq - 1);
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

  it("uses Claude Code's structured template: nine sections, analysis and summary wrappers", () => {
    const req = buildCompactionRequest("User: hi", "fake-1", 12_000);
    const instruction = req.system[0]?.text ?? "";
    for (const section of [
      "Primary Request and Intent",
      "Key Technical Concepts",
      "Files and Code Sections",
      "Errors and fixes",
      "Problem Solving",
      "All user messages",
      "Pending Tasks",
      "Current Work",
      "Optional Next Step",
    ]) {
      expect(instruction).toContain(section);
    }
    expect(instruction).toContain("<analysis>");
    expect(instruction).toContain("</analysis>");
    expect(instruction).toContain("<summary>");
    expect(instruction).toContain("</summary>");
    // the two Capybara adaptations
    expect(instruction).toContain("Write in the same language as the conversation");
    expect(instruction).toContain(
      "If the transcript starts with an earlier summary, merge it into your summary",
    );
    expect(req.maxOutputTokens).toBe(12_000);
  });

  it("defaults the output cap to COMPACTION_MAX_OUTPUT_TOKENS (20000)", () => {
    expect(COMPACTION_MAX_OUTPUT_TOKENS).toBe(20_000);
    expect(buildCompactionRequest("User: hi", "fake-1").maxOutputTokens).toBe(20_000);
  });
});

describe("compactionChunkSize", () => {
  it("leaves room for the summary allowance and the request overhead inside the input budget", () => {
    const window = 10_000;
    const cap = 1000;
    const reserve = 2000;
    const budget = compactionInputBudget(window, cap, reserve);
    const size = compactionChunkSize(budget, cap);
    const overhead = compactionRequestOverhead();
    expect(overhead).toBeGreaterThan(0);
    // one call's input: its chunk plus the request's fixed overhead (and the running summary it
    // may carry, bounded by the summary allowance) stays inside the input budget
    expect(size + overhead + Math.ceil(cap / 2)).toBeLessThanOrEqual(budget);
    // and the real request: its input plus the output cap and the reserve fits the window
    expect(size + overhead + cap + reserve).toBeLessThanOrEqual(window);
  });
});

describe("chunkTranscript", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkTranscript("", 100)).toEqual([]);
  });

  it("returns a transcript that fits as one chunk", () => {
    expect(chunkTranscript("a\nb", 100)).toEqual(["a\nb"]);
  });

  it("splits at line boundaries and counts the separators", () => {
    // 4 ASCII characters are one token and a separator one more, so two lines are 3 tokens
    expect(chunkTranscript("aaaa\nbbbb\ncccc", 2)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(chunkTranscript("aaaa\nbbbb\ncccc", 3)).toEqual(["aaaa\nbbbb", "cccc"]);
    // the claim holds on the estimator: every chunk is at most the size
    for (const chunk of chunkTranscript("aaaa\nbbbb\ncccc", 3)) {
      expect(textTokensOf(chunk)).toBeLessThanOrEqual(3);
    }
  });

  it("hard-splits a single line over the chunk size at a character boundary, with a marker", () => {
    // 400 ASCII characters are 100 tokens; a piece is at most 20 tokens minus the marker's 4, and
    // the 80-character tail is exactly 20 tokens so it stays whole
    const chunks = chunkTranscript("x".repeat(400), 20);
    expect(chunks).toHaveLength(6);
    expect(chunks[0]).toBe(`${"x".repeat(64)}\n[chunk split]\n`);
    expect(chunks.at(-1)).toBe("x".repeat(80));
    // the pieces reassemble into the original line
    expect(chunks.join("").replaceAll("\n[chunk split]\n", "")).toBe("x".repeat(400));
    for (const chunk of chunks) expect(textTokensOf(chunk)).toBeLessThanOrEqual(20);
  });

  it("never cuts a UTF-16 surrogate pair", () => {
    // an emoji is two UTF-16 units and one token; a cut inside it would leave a lone surrogate
    const emoji = "\u{1F600}";
    const chunks = chunkTranscript(emoji.repeat(20), 8);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const text = chunk.replaceAll("\n[chunk split]\n", "");
      expect(text).toBe(emoji.repeat(text.length / 2));
    }
  });
});

describe("extractSummary", () => {
  it("returns the summary block and drops the analysis scratchpad", () => {
    expect(extractSummary("<analysis>x</analysis><summary>\nS\n</summary>")).toBe("S");
  });

  it("returns a plain answer without tags, trimmed", () => {
    expect(extractSummary("  plain summary  ")).toBe("plain summary");
  });

  it("returns an empty string when only analysis remains, so the attempt fails", () => {
    expect(extractSummary("<analysis>only thinking</analysis>")).toBe("");
  });

  it("removes an analysis block from an untagged answer", () => {
    expect(extractSummary("<analysis>t</analysis>\nThe summary.")).toBe("The summary.");
  });

  it("strips a dangling summary tag when the model was cut off after the opening tag", () => {
    // a truncated response: the closing tag never arrived, but the literal "<summary>" must not
    // reach a later request
    expect(extractSummary("<analysis>x</analysis><summary>Partial answer")).toBe("Partial answer");
    expect(extractSummary("Partial answer</summary>")).toBe("Partial answer");
  });
});

describe("summarySavedTokens", () => {
  it("is the transcript estimate minus the stored summary estimate", () => {
    // 400 ASCII characters ≈ 100 tokens, 40 ≈ 10 tokens
    expect(summarySavedTokens("x".repeat(400), "y".repeat(40))).toBe(90);
  });

  it("is never negative when the summary is longer than the transcript", () => {
    expect(summarySavedTokens("x".repeat(40), "y".repeat(400))).toBe(0);
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
