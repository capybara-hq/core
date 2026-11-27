import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationBusMessage } from "../../src/conversations/event-log.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { createLogger } from "../../src/log.js";
import {
  DRAFT_FLUSH_MS,
  DRAFT_TOOL_INPUT_MAX,
  DRAFT_TTL_SECONDS,
  draftKey,
  mergeDraftBase,
  RunDrafts,
  streamSink,
} from "../../src/runtime/run-drafts.js";

let rd: TestContainer;
let redis: Redis;
const quiet = createLogger("error", { write: () => {} });
/** The provider over a real Redis; the database and the log are not used by these cases. */
const draftsOn = (r: Redis) =>
  new RunDrafts(r, {} as KernelDb, { findByIdem: async () => undefined }, quiet);
const stored = async (runId: string, step: number) => {
  const v = await redis.get(draftKey(runId, step));
  return v === null ? null : (JSON.parse(v) as { text: string; thinking: string; tools?: unknown });
};

beforeAll(async () => {
  rd = await startTestRedis({ shared: true });
  redis = new Redis(rd.url);
});
afterAll(async () => {
  redis?.disconnect();
  await rd?.stop();
});
beforeEach(async () => {
  await redis.flushdb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RunDrafts", () => {
  it("writes the first delta at once, holds the next ones within the window, then writes all", async () => {
    // The trailing timer is faked too: a real 1 ms timer armed by the held delta fires during the
    // Redis round trip under load and writes early, so the delta past the window is held again.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    const d = draftsOn(redis);
    d.append("r1", 1, "text", "Hel");
    expect(await stored("r1", 1)).toEqual({ text: "Hel", thinking: "", tools: [] });

    vi.setSystemTime(1_000_000 + DRAFT_FLUSH_MS - 1);
    d.append("r1", 1, "text", "lo");
    d.append("r1", 1, "thinking", "hmm");
    // coalesced: still the first write
    expect(await stored("r1", 1)).toEqual({ text: "Hel", thinking: "", tools: [] });

    vi.setSystemTime(1_000_000 + DRAFT_FLUSH_MS);
    d.append("r1", 1, "text", " world");
    expect(await stored("r1", 1)).toEqual({ text: "Hello world", thinking: "hmm", tools: [] });
  });

  it("a held delta is written when the window ends, with no further delta (one trailing timer)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    const d = draftsOn(redis);
    d.append("r1", 1, "text", "a");
    vi.setSystemTime(1_000_000 + 50);
    d.append("r1", 1, "text", "b");
    d.append("r1", 1, "thinking", "c");
    // one timer for the held step, however many deltas it holds
    expect(vi.getTimerCount()).toBe(1);
    expect(await stored("r1", 1)).toEqual({ text: "a", thinking: "", tools: [] });
    vi.advanceTimersByTime(DRAFT_FLUSH_MS - 50);
    expect(vi.getTimerCount()).toBe(0);
    expect(await stored("r1", 1)).toEqual({ text: "ab", thinking: "c", tools: [] });
  });

  it("the trailing timer goes with a write, a clear or a release", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    const d = draftsOn(redis);
    // a write on the next delta past the window takes the timer's place
    d.append("r1", 1, "text", "a");
    d.append("r1", 1, "text", "b");
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(1_000_000 + DRAFT_FLUSH_MS);
    d.append("r1", 1, "text", "c");
    expect(vi.getTimerCount()).toBe(0);
    // clear
    d.append("r1", 1, "text", "d");
    expect(vi.getTimerCount()).toBe(1);
    d.clear("r1", 1);
    expect(vi.getTimerCount()).toBe(0);
    // release
    d.append("r2", 1, "text", "x");
    d.append("r2", 1, "text", "y");
    expect(vi.getTimerCount()).toBe(1);
    d.release("r2");
    expect(vi.getTimerCount()).toBe(0);
    // flush at stream end
    d.append("r3", 1, "text", "x");
    d.append("r3", 1, "text", "y");
    d.flush("r3", 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await stored("r3", 1)).toEqual({ text: "xy", thinking: "", tools: [] });
    // nothing fires after the clear / release
    vi.advanceTimersByTime(DRAFT_FLUSH_MS * 2);
    expect(await stored("r1", 1)).toBeNull();
    expect(await stored("r2", 1)).toEqual({ text: "x", thinking: "", tools: [] });
  });

  it("sets the key's TTL to 600 s and refreshes it on every write", async () => {
    expect(DRAFT_TTL_SECONDS).toBe(600);
    const d = draftsOn(redis);
    d.append("r1", 1, "text", "a");
    await redis.expire(draftKey("r1", 1), 5);
    vi.setSystemTime(1_000_000 + DRAFT_FLUSH_MS);
    d.append("r1", 1, "text", "b");
    const ttl = await redis.ttl(draftKey("r1", 1));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("flush writes what the window still holds; nothing when nothing is held", async () => {
    const d = draftsOn(redis);
    d.append("r1", 2, "text", "a");
    d.append("r1", 2, "text", "b");
    expect(await stored("r1", 2)).toEqual({ text: "a", thinking: "", tools: [] });
    d.flush("r1", 2);
    expect(await stored("r1", 2)).toEqual({ text: "ab", thinking: "", tools: [] });
    // nothing held for another step
    d.flush("r1", 3);
    expect(await stored("r1", 3)).toBeNull();
  });

  it("read lists the run's steps with drafts; clear deletes the step's draft", async () => {
    const d = draftsOn(redis);
    d.append("r1", 1, "thinking", "t1");
    d.append("r1", 2, "text", "x2");
    d.append("other", 1, "text", "o");
    expect(await d.read("r1")).toEqual([
      { step: 1, text: "", thinking: "t1", tools: [] },
      { step: 2, text: "x2", thinking: "", tools: [] },
    ]);
    d.clear("r1", 1);
    expect(await stored("r1", 1)).toBeNull();
    expect(await d.read("r1")).toEqual([{ step: 2, text: "x2", thinking: "", tools: [] }]);
    d.clear("r1", 2);
    expect(await d.read("r1")).toEqual([]);
    expect(await d.read("other")).toEqual([{ step: 1, text: "o", thinking: "", tools: [] }]);
    // every key the drafts use expires
    for (const k of await redis.keys("*")) expect(await redis.ttl(k)).toBeGreaterThan(0);
  });

  it("after a clear the step starts over: the next delta is written at once, alone", async () => {
    const d = draftsOn(redis);
    d.append("r1", 1, "text", "first try");
    d.clear("r1", 1);
    d.append("r1", 1, "text", "second");
    expect(await stored("r1", 1)).toEqual({ text: "second", thinking: "", tools: [] });
  });

  it("draft keeps tools and the base", async () => {
    const d = draftsOn(redis);
    d.append("r1", 1, "text", "Writing it.");
    d.startTool("r1", 1, "c1", "Write");
    d.appendToolInput("r1", 1, "c1", '{"path":"a.txt"');
    d.setToolBase("r1", 1, "c1", { text: "old\n", sha256: "abc" });
    d.appendToolInput("r1", 1, "c1", ',"content":"new');
    d.startTool("r1", 1, "c2", "Bash");
    d.flush("r1", 1);
    expect(await d.read("r1")).toEqual([
      {
        step: 1,
        text: "Writing it.",
        thinking: "",
        tools: [
          {
            id: "c1",
            name: "Write",
            input: '{"path":"a.txt","content":"new',
            base: { text: "old\n", sha256: "abc" },
          },
          { id: "c2", name: "Bash", input: "" },
        ],
      },
    ]);
  });

  it("a guessed base takes its verdict; a rejected guess gives way to the exact base", async () => {
    const d = draftsOn(redis);
    d.startTool("r1", 1, "c1", "Write");
    // a verdict before any base is ignored
    d.setToolBaseVerdict("r1", 1, "c1", true);
    d.setToolBase("r1", 1, "c1", { text: "g\n", sha256: "hg", guess: { path: "/w/g.py" } });
    // a second guess is not taken
    d.setToolBase("r1", 1, "c1", { text: "x\n", sha256: "hx", guess: { path: "/w/x.py" } });
    d.setToolBaseVerdict("r1", 1, "c1", false);
    d.flush("r1", 1);
    expect((await d.read("r1"))[0]?.tools[0]?.base).toEqual({
      text: "g\n",
      sha256: "hg",
      guess: { path: "/w/g.py" },
      verdict: "rejected",
    });
    d.setToolBase("r1", 1, "c1", { text: "real\n", sha256: "hr" });
    d.flush("r1", 1);
    expect((await d.read("r1"))[0]?.tools[0]?.base).toEqual({ text: "real\n", sha256: "hr" });

    d.startTool("r1", 1, "c2", "Write");
    d.setToolBase("r1", 1, "c2", { text: "g\n", sha256: "hg", guess: { path: "/w/g.py" } });
    d.setToolBaseVerdict("r1", 1, "c2", true);
    // a later verdict does not change a confirmed guess
    d.setToolBaseVerdict("r1", 1, "c2", false);
    d.flush("r1", 1);
    expect((await d.read("r1"))[0]?.tools[1]?.base?.verdict).toBe("confirmed");
  });

  it("a Redis failure is logged, never thrown to the run", async () => {
    const broken = new Redis(rd.url, { lazyConnect: true, maxRetriesPerRequest: 0 });
    broken.disconnect();
    const warn = vi.fn();
    const d = new RunDrafts(
      broken,
      {} as KernelDb,
      { findByIdem: async () => undefined },
      { ...quiet, warn },
    );
    expect(() => d.append("r1", 1, "text", "a")).not.toThrow();
    expect(() => d.clear("r1", 1)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe("streamSink", () => {
  /** A sink over recording doubles: every call in order. */
  function recorded() {
    const calls: string[] = [];
    const published: ConversationBusMessage[] = [];
    const sink = streamSink("c1", {
      bus: {
        publish: async (topic, m) => {
          calls.push(`publish ${topic}`);
          published.push(m as ConversationBusMessage);
        },
      },
      drafts: {
        append: (runId, step, channel, text) =>
          calls.push(`append ${runId}:${step} ${channel} ${text}`),
        flush: (runId, step) => calls.push(`flush ${runId}:${step}`),
        clear: (runId, step) => calls.push(`clear ${runId}:${step}`),
        startTool: (runId, step, callId, name) =>
          calls.push(`startTool ${runId}:${step} ${callId} ${name}`),
        appendToolInput: (runId, step, callId, text) =>
          calls.push(`appendToolInput ${runId}:${step} ${callId} ${text}`),
        setToolBase: (runId, step, callId, base) =>
          calls.push(
            `setToolBase ${runId}:${step} ${callId} ${base.sha256}${base.guess ? ` guess ${base.guess.path}` : ""}`,
          ),
        setToolBaseVerdict: (runId, step, callId, confirmed) =>
          calls.push(`setToolBaseVerdict ${runId}:${step} ${callId} ${confirmed}`),
      },
      log: quiet,
    });
    return { sink, calls, published };
  }

  it("gives text and thinking deltas each their own offset in the step", () => {
    const { sink, published } = recorded();
    sink({ kind: "thinking", runId: "r", step: 1, text: "ab" });
    sink({ kind: "text", runId: "r", step: 1, text: "xyz" });
    sink({ kind: "thinking", runId: "r", step: 1, text: "c" });
    sink({ kind: "text", runId: "r", step: 1, text: "w" });
    sink({ kind: "text", runId: "r", step: 2, text: "n" });
    expect(published).toEqual([
      { kind: "delta", runId: "r", step: 1, delta: "thinking", text: "ab", offset: 0 },
      { kind: "delta", runId: "r", step: 1, delta: "text", text: "xyz", offset: 0 },
      { kind: "delta", runId: "r", step: 1, delta: "thinking", text: "c", offset: 2 },
      { kind: "delta", runId: "r", step: 1, delta: "text", text: "w", offset: 3 },
      { kind: "delta", runId: "r", step: 2, delta: "text", text: "n", offset: 0 },
    ]);
  });

  it("feeds the draft before publishing, so a viewer who sees the delta can read it", () => {
    const { sink, calls } = recorded();
    sink({ kind: "text", runId: "r", step: 1, text: "hi" });
    expect(calls).toEqual(["append r:1 text hi", "publish conv.c1"]);
  });

  it("step_reset clears the draft and both offsets, and is published", () => {
    const { sink, calls, published } = recorded();
    sink({ kind: "text", runId: "r", step: 1, text: "abc" });
    sink({ kind: "thinking", runId: "r", step: 1, text: "t" });
    calls.length = 0;
    sink({ kind: "step_reset", runId: "r", step: 1 });
    sink({ kind: "text", runId: "r", step: 1, text: "d" });
    sink({ kind: "thinking", runId: "r", step: 1, text: "u" });
    expect(calls.slice(0, 2)).toEqual(["clear r:1", "publish conv.c1"]);
    expect(published.slice(2)).toEqual([
      { kind: "delta", runId: "r", step: 1, delta: "step_reset" },
      { kind: "delta", runId: "r", step: 1, delta: "text", text: "d", offset: 0 },
      { kind: "delta", runId: "r", step: 1, delta: "thinking", text: "u", offset: 0 },
    ]);
  });

  it("streamSink offsets tool input per call", () => {
    const { sink, calls, published } = recorded();
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "a", name: "Write" });
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "b", name: "Bash" });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: '{"pa' });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "b", text: '{"co' });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: 'th":' });
    sink({ kind: "tool_base", runId: "r", step: 1, callId: "a", text: "old", sha256: "h" });
    expect(published).toEqual([
      { kind: "delta", runId: "r", step: 1, delta: "tool_start", callId: "a", name: "Write" },
      { kind: "delta", runId: "r", step: 1, delta: "tool_start", callId: "b", name: "Bash" },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_input",
        callId: "a",
        text: '{"pa',
        offset: 0,
      },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_input",
        callId: "b",
        text: '{"co',
        offset: 0,
      },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_input",
        callId: "a",
        text: 'th":',
        offset: 4,
      },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_base",
        callId: "a",
        text: "old",
        sha256: "h",
      },
    ]);
    // the draft is fed before each publish
    expect(calls.filter((c) => !c.startsWith("publish"))).toEqual([
      "startTool r:1 a Write",
      "startTool r:1 b Bash",
      'appendToolInput r:1 a {"pa',
      'appendToolInput r:1 b {"co',
      'appendToolInput r:1 a th":',
      "setToolBase r:1 a h",
    ]);
  });

  it("publishes a guessed base with its path and the verdict on it", () => {
    const { sink, calls, published } = recorded();
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "a", name: "Write" });
    sink({
      kind: "tool_base",
      runId: "r",
      step: 1,
      callId: "a",
      text: "old",
      sha256: "h",
      guess: { path: "/w/a.py" },
    });
    sink({ kind: "tool_base_verdict", runId: "r", step: 1, callId: "a", confirmed: true });
    expect(published.slice(1)).toEqual([
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_base",
        callId: "a",
        text: "old",
        sha256: "h",
        guess: { path: "/w/a.py" },
      },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_base_verdict",
        callId: "a",
        confirmed: true,
      },
    ]);
    expect(calls.filter((c) => !c.startsWith("publish")).slice(1)).toEqual([
      "setToolBase r:1 a h guess /w/a.py",
      "setToolBaseVerdict r:1 a true",
    ]);
  });

  it("step_reset clears tools", async () => {
    const d = draftsOn(redis);
    const published: ConversationBusMessage[] = [];
    const sink = streamSink("c1", {
      bus: { publish: async (_t, m) => void published.push(m as ConversationBusMessage) },
      drafts: d,
      log: quiet,
    });
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "a", name: "Write" });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: "abc" });
    sink({ kind: "step_reset", runId: "r", step: 1 });
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "a", name: "Write" });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: "x" });
    sink({ kind: "stream_end", runId: "r", step: 1 });
    expect(published.at(-1)).toEqual({
      kind: "delta",
      runId: "r",
      step: 1,
      delta: "tool_input",
      callId: "a",
      text: "x",
      offset: 0,
    });
    await vi.waitFor(async () =>
      expect(await d.read("r")).toEqual([
        { step: 1, text: "", thinking: "", tools: [{ id: "a", name: "Write", input: "x" }] },
      ]),
    );
  });

  it("tool input past DRAFT_TOOL_INPUT_MAX is published but marks inputTruncated", async () => {
    expect(DRAFT_TOOL_INPUT_MAX).toBe(512 * 1024);
    const d = draftsOn(redis);
    const published: ConversationBusMessage[] = [];
    const sink = streamSink("c1", {
      bus: { publish: async (_t, m) => void published.push(m as ConversationBusMessage) },
      drafts: d,
      log: quiet,
    });
    const head = "a".repeat(DRAFT_TOOL_INPUT_MAX - 2);
    sink({ kind: "tool_start", runId: "r", step: 1, callId: "a", name: "Write" });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: head });
    // "éé" is 4 UTF-8 bytes: past the cap by 2 though only 2 characters
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: "éé" });
    sink({ kind: "tool_input", runId: "r", step: 1, callId: "a", text: "z" });
    sink({ kind: "stream_end", runId: "r", step: 1 });
    expect(published.slice(2)).toEqual([
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_input",
        callId: "a",
        text: "éé",
        offset: head.length,
      },
      {
        kind: "delta",
        runId: "r",
        step: 1,
        delta: "tool_input",
        callId: "a",
        text: "z",
        offset: head.length + 2,
      },
    ]);
    await vi.waitFor(async () =>
      expect(await d.read("r")).toEqual([
        {
          step: 1,
          text: "",
          thinking: "",
          tools: [{ id: "a", name: "Write", input: head, inputTruncated: true }],
        },
      ]),
    );
  });

  it("stream_end flushes and step_end clears the draft; neither is published", () => {
    const { sink, calls, published } = recorded();
    sink({ kind: "stream_end", runId: "r", step: 1 });
    sink({ kind: "step_end", runId: "r", step: 1 });
    expect(calls).toEqual(["flush r:1", "clear r:1"]);
    expect(published).toEqual([]);
  });
});

describe("mergeDraftBase", () => {
  const guess = { text: "g", sha256: "hg", guess: { path: "/w/g" } };
  it("keeps the first base; an exact base replaces a guess not confirmed", () => {
    const exact = { text: "e", sha256: "he" };
    expect(mergeDraftBase(undefined, guess)).toBe(guess);
    expect(mergeDraftBase(exact, guess)).toBe(exact);
    // only read after a rejection: a copy still showing the guess missed the verdict
    expect(mergeDraftBase(guess, exact)).toBe(exact);
    const confirmedGuess = { ...guess, verdict: "confirmed" as const };
    expect(mergeDraftBase(confirmedGuess, exact)).toBe(confirmedGuess);
    const rejected = { ...guess, verdict: "rejected" as const };
    expect(mergeDraftBase(rejected, exact)).toBe(exact);
    // a lagging copy of the guess never brings it back
    expect(mergeDraftBase(rejected, guess)).toBe(rejected);
  });
  it("gives the same guess the verdict it lacks", () => {
    expect(mergeDraftBase(guess, { ...guess, verdict: "confirmed" })).toEqual({
      ...guess,
      verdict: "confirmed",
    });
    const confirmed = { ...guess, verdict: "confirmed" as const };
    expect(mergeDraftBase(confirmed, { ...guess, verdict: "rejected" })).toBe(confirmed);
  });
});
