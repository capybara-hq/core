import { describe, expect, it } from "vitest";
import { BEHAVIOR_RULES, buildModelRequest } from "../../../src/runtime/context/build.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

const build = (log: Log, step = 0) =>
  buildModelRequest({ events: log.events, agent: AGENT, agentVersion: 1, model: MODEL, step });

const opaqueThinking = {
  type: "thinking" as const,
  text: "let me think",
  opaque: { provider: "model-fake", model: "fake-1", data: { signature: "sig-xyz", n: [1, 2] } },
};

describe("buildModelRequest", () => {
  it("builds system from behavior rules + instructions with a cache breakpoint", () => {
    const log = new Log();
    log.user("hi");
    const { request } = build(log);
    expect(request.system).toEqual([
      { text: `${BEHAVIOR_RULES}\n\n${AGENT.instructions}`, cache: true },
    ]);
    expect(request.model).toBe("fake-1");
    expect(request.tools).toEqual([]);
    expect(request.maxOutputTokens).toBe(MODEL.maxOutputTokens);
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(request.effort).toBeUndefined();
  });

  it("passes effort only when set and supported by the model", () => {
    const log = new Log();
    log.user("hi");
    const agent = { ...AGENT, effort: "high" as const };
    const input = { events: log.events, agent, agentVersion: 1, step: 0 };
    expect(buildModelRequest({ ...input, model: MODEL }).request.effort).toBe("high");
    const noEffort = { ...MODEL, capabilities: { ...MODEL.capabilities, effort: false } };
    expect(buildModelRequest({ ...input, model: noEffort }).request.effort).toBeUndefined();
  });

  it("is deterministic: same events and definition give deep-equal requests and hashes", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.assistant([opaqueThinking, { type: "text", text: "hello" }]);
    log.user("again");
    const a = build(log);
    const b = build(log);
    expect(a.request).toEqual(b.request);
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.systemHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("system text is identical across conversations for the same agent version", () => {
    const l1 = new Log("conv-1");
    l1.user("hi");
    const l2 = new Log("conv-2", 500);
    l2.user("a completely different conversation");
    l2.assistant("ok");
    l2.user("more");
    const a = build(l1, 0);
    const b = build(l2, 7);
    expect(a.request.system).toEqual(b.request.system);
    expect(a.meta.systemHash).toBe(b.meta.systemHash);
    expect(a.request.system[0]?.text).not.toContain("conv-");
  });

  it("is append-only: appending a user message keeps the previous messages as a prefix", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.assistant([opaqueThinking, { type: "text", text: "hello" }]);
    log.reminder("You are close to the step limit.");
    log.assistant("partial ans", "aborted");
    const r1 = build(log).request;
    log.user("next");
    const r2 = build(log).request;
    expect(r2.messages.length).toBe(r1.messages.length + 1);
    expect(r2.messages.slice(0, r1.messages.length)).toEqual(r1.messages);
    expect(r2.messages[1]).toEqual({
      role: "assistant",
      content: [opaqueThinking, { type: "text", text: "hello" }],
    });
  });

  it("replays reminders as system messages at their log position and lists their seqs", () => {
    const log = new Log();
    log.user("hi");
    log.assistant("step 0");
    const rem = log.reminder("Wrap up now.", 1);
    log.assistant("final", "end_turn", 1);
    const { request, meta } = build(log, 2);
    expect(request.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "assistant",
    ]);
    expect(request.messages[2]).toEqual({ role: "system", content: "Wrap up now." });
    expect(meta.reminderSeqs).toEqual([rem.seq]);
  });

  it("replays aborted assistant messages with their partial text", () => {
    const log = new Log();
    log.user("hi");
    log.assistant("half an ans", "aborted");
    log.user("continue");
    const { request } = build(log);
    expect(request.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "half an ans" }],
    });
  });

  it("skips assistant messages with no content (aborted before any output)", () => {
    const log = new Log();
    log.user("hi");
    log.assistant([], "aborted");
    log.user("hello?");
    const { request } = build(log);
    expect(request.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("after compaction: starts with the summary and drops events it covers", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    const covered = log.events.at(-1)?.seq ?? 0;
    log.turn(3);
    const sum = log.summary(covered, "They asked two questions.");
    log.user("question 4");
    const { request, meta } = build(log);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<conversation_summary>\nThey asked two questions.\n</conversation_summary>",
        },
      ],
    });
    const texts = JSON.stringify(request.messages);
    expect(texts).not.toContain("question 1");
    expect(texts).not.toContain("answer 2");
    expect(request.messages.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "question 3" }] },
      { role: "assistant", content: [{ type: "text", text: "answer 3" }] },
      { role: "user", content: [{ type: "text", text: "question 4" }] },
    ]);
    expect(meta.summarySeq).toBe(sum.seq);
    expect(meta.fromSeq).toBe(covered + 1);
    expect(meta.toSeq).toBe(log.events.at(-1)?.seq);
  });

  it("uses only the latest summary", () => {
    const log = new Log();
    log.turn(1);
    log.summary(2, "old summary");
    log.turn(2);
    log.turn(3);
    log.summary(6, "new summary");
    log.user("question 4");
    const { request } = build(log);
    const texts = JSON.stringify(request.messages);
    expect(texts).toContain("new summary");
    expect(texts).not.toContain("old summary");
    expect(texts).not.toContain("question 2");
  });

  it("is reconstructible: slicing the log by meta rebuilds the same request", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    log.turn(3);
    log.summary(4, "summary of 1 and 2");
    log.runStarted();
    log.user("question 4");
    log.reminder("Wrap up.");
    log.assistant([opaqueThinking, { type: "text", text: "answer 4" }]);
    log.user("question 5");
    const { request, meta } = build(log);
    const slice = log.events.filter(
      (e) => (e.seq >= meta.fromSeq && e.seq <= meta.toSeq) || e.seq === meta.summarySeq,
    );
    expect(slice.length).toBeLessThan(log.events.length);
    const again = buildModelRequest({
      events: slice,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 0,
    });
    expect(again.request).toEqual(request);
    expect(again.meta).toEqual(meta);
  });

  it("meta without a summary covers the whole log", () => {
    const log = new Log("conv-1", 10);
    log.user("hi");
    log.assistant("hello");
    const { meta } = build(log);
    expect(meta).toMatchObject({ fromSeq: 10, toSeq: 11, summarySeq: null, reminderSeqs: [] });
  });
});
