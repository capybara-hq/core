import { randomUUID } from "node:crypto";
import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, LogContentBlock } from "../../../src/conversations/events.js";
import { buildModelRequest, mediaRefs } from "../../../src/runtime/context/build.js";
import { openingSeqs } from "../../../src/runtime/context/compaction.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

/**
 * A summary that cuts inside a user turn (context compaction spec §4.2, revision 2026-11-15): the
 * turn's opening user message is covered, later events of the turn are not. The summary records
 * which messages started the run (`openingSeqs`, decided when it is written) and request building
 * shows exactly those again, verbatim, in the summary's user message.
 */

const build = (log: Log, model: ModelInfo = MODEL) =>
  buildModelRequest({ events: log.events, agent: AGENT, agentVersion: 1, model, step: 3 });

const SUMMARY = "<conversation_summary>\nThe agent read ledger 1.\n</conversation_summary>";

/** A tool step: the assistant's call, then its result. */
function step(log: Log, n: number): { call: ConversationEvent; result: ConversationEvent } {
  const call = log.assistant(
    [{ type: "tool_call", id: `call-${n}`, name: "Read", input: { n } }],
    "tool_use",
    n,
  );
  const result = log.add({
    type: "tool_result",
    payload: {
      step: n,
      callId: `call-${n}`,
      toolKey: "Read",
      content: `ledger ${n}`,
      isError: false,
    },
  });
  return { call, result };
}

function userMessage(
  log: Log,
  content: LogContentBlock[],
  sender?: { name: string; role?: "owner" | "admin" | "member" },
): ConversationEvent {
  return log.add(
    {
      type: "user_message",
      payload: { content, authorAccountId: "acc-1", ...(sender !== undefined && { sender }) },
    },
    null,
  );
}

describe("buildModelRequest: a summary inside the latest user turn", () => {
  it("re-renders the summary's openingSeqs after the summary text, then the kept tool pairs", () => {
    const log = new Log();
    const task = log.user("audit the ledgers");
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.", [task.seq]);
    const { request, meta } = build(log);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: SUMMARY },
          { type: "text", text: "audit the ledgers" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-2", name: "Read", input: { n: 2 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", callId: "call-2", content: "ledger 2", isError: false }],
      },
    ]);
    expect(meta.fromSeq).toBe(first.result.seq + 1);
  });

  it("a summary without openingSeqs (an older log) re-renders nothing, even inside a turn", () => {
    const log = new Log();
    log.user("audit the ledgers");
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.");
    const { request } = build(log);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: SUMMARY }],
    });
    expect(request.messages[1]?.role).toBe("assistant");
  });

  it("re-renders several opening messages in seq order", () => {
    const log = new Log();
    const a = log.user("audit the ledgers");
    log.runStarted();
    const b = log.user("and the invoices");
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.", [a.seq, b.seq]);
    const head = build(log).request.messages[0];
    expect(head?.content).toEqual([
      { type: "text", text: SUMMARY },
      { type: "text", text: "audit the ledgers" },
      { type: "text", text: "and the invoices" },
    ]);
  });

  it("renders the message as an ordinary user message: its sender line comes first", () => {
    const log = new Log();
    const task = userMessage(log, [{ type: "text", text: "audit the ledgers" }], {
      name: "Ana",
      role: "admin",
    });
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.", [task.seq]);
    // a later message from the same sender carries no line again
    userMessage(log, [{ type: "text", text: "and March?" }], { name: "Ana", role: "admin" });
    const { request } = build(log);
    const head = request.messages[0];
    expect(head?.content).toEqual([
      { type: "text", text: SUMMARY },
      { type: "text", text: "From Ana (admin)" },
      { type: "text", text: "audit the ledgers" },
    ]);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "and March?" }],
    });
  });

  it("resolves the message's media like any user message, and asks for its bytes", () => {
    const img = randomUUID();
    const see: ModelInfo = { ...MODEL, capabilities: { ...MODEL.capabilities, vision: true } };
    const log = new Log();
    const task = userMessage(log, [
      { type: "text", text: "what is on this receipt?" },
      {
        type: "image",
        mediaType: "image/png",
        source: { kind: "ref", attachmentId: img },
        name: "receipt.png",
      },
    ]);
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.", [task.seq]);
    expect(mediaRefs(log.events, see)).toEqual([img]);
    // no row for the attachment here: the same placeholder an ordinary message gets
    const head = build(log, see).request.messages[0];
    expect(head?.content).toEqual([
      { type: "text", text: SUMMARY },
      { type: "text", text: "what is on this receipt?" },
      { type: "text", text: '[Attachment "receipt.png" is no longer available.]' },
    ]);
  });
});

describe("openingSeqs: the messages a summary records to re-render", () => {
  it("the run's opening message, only when the summary covers it", () => {
    const log = new Log();
    log.user("old question");
    log.add(
      {
        type: "assistant_message",
        payload: { step: 1, content: [{ type: "text", text: "old" }], stopReason: "end_turn" },
      },
      "run-0",
    );
    const task = log.user("audit the ledgers");
    log.runStarted();
    log.modelCall(task.seq);
    const first = step(log, 1);
    expect(openingSeqs(log.events, "run-1", first.result.seq)).toEqual([task.seq]);
    // a summary that ends before the message covers no opening message
    expect(openingSeqs(log.events, "run-1", task.seq - 1)).toEqual([]);
  });

  it("several messages before the run's first call: all of them", () => {
    const log = new Log();
    const a = log.user("audit the ledgers");
    log.runStarted();
    const b = log.user("and the invoices");
    log.modelCall(b.seq);
    const first = step(log, 1);
    expect(openingSeqs(log.events, "run-1", first.result.seq)).toEqual([a.seq, b.seq]);
  });

  it("before the run's first call, the request about to be built decides the absorption", () => {
    const log = new Log();
    const a = log.user("audit the ledgers");
    log.runStarted();
    const b = log.user("and the invoices");
    expect(openingSeqs(log.events, "run-1", b.seq, a.seq)).toEqual([a.seq]);
    expect(openingSeqs(log.events, "run-1", b.seq, b.seq)).toEqual([a.seq, b.seq]);
  });

  it("a cut that lands on an interjection still records the run's opening message, not it", () => {
    const log = new Log();
    const task = log.user("audit the ledgers");
    log.runStarted();
    log.modelCall(task.seq);
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Read", input: { n: 1 } }],
      "tool_use",
      1,
    );
    const interjection = log.user("interjection: skip March");
    log.add({
      type: "tool_result",
      payload: { step: 1, callId: "call-1", toolKey: "Read", content: "ledger 1", isError: false },
    });
    expect(openingSeqs(log.events, "run-1", interjection.seq)).toEqual([task.seq]);
  });

  it("none for a run a finished background task woke (no message opened it)", () => {
    const log = new Log();
    log.user("start the export in the background");
    log.add({
      type: "run_started",
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId: "acc-1",
        trigger: "background_task",
      },
    });
    const first = step(log, 1);
    expect(openingSeqs(log.events, "run-1", first.result.seq)).toEqual([]);
  });

  it("none for a run that has not started (a manual compact run is another run)", () => {
    const log = new Log();
    const task = log.user("audit the ledgers");
    expect(openingSeqs(log.events, "compact-run", task.seq)).toEqual([]);
  });
});
