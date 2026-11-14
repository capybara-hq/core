import { randomUUID } from "node:crypto";
import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, LogContentBlock } from "../../../src/conversations/events.js";
import { buildModelRequest, mediaRefs } from "../../../src/runtime/context/build.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

/**
 * A summary that cuts inside a user turn (context compaction spec §4.2, revision 2026-11-15): the
 * turn's opening user message is covered, later events of the turn are not. Request building shows
 * that message again, verbatim, in the summary's user message.
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
  it("re-renders the turn's user message after the summary text, then the kept tool pairs", () => {
    const log = new Log();
    log.user("audit the ledgers");
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.");
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

  it("leaves a summary at a user-message boundary as before (no message re-rendered)", () => {
    const log = new Log();
    log.user("audit the ledgers");
    log.runStarted();
    const first = step(log, 1);
    log.add({
      type: "run_finished",
      payload: { reason: "completed", consumedUpToSeq: first.result.seq },
    });
    log.user("now the invoices");
    log.summary(first.result.seq + 1, "The agent read ledger 1.");
    const { request } = build(log);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: SUMMARY }] },
      { role: "user", content: [{ type: "text", text: "now the invoices" }] },
    ]);
  });

  it("re-renders only the turn-opening message, not a covered interjection", () => {
    const log = new Log();
    log.user("audit the ledgers");
    log.runStarted();
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Read", input: { n: 1 } }],
      "tool_use",
      1,
    );
    log.user("interjection: skip March");
    const r1 = log.add({
      type: "tool_result",
      payload: { step: 1, callId: "call-1", toolKey: "Read", content: "ledger 1", isError: false },
    });
    step(log, 2);
    log.summary(r1.seq, "The agent read ledger 1; skip March.");
    const { request } = build(log);
    const head = request.messages[0];
    expect(head?.content).toEqual([
      {
        type: "text",
        text: "<conversation_summary>\nThe agent read ledger 1; skip March.\n</conversation_summary>",
      },
      { type: "text", text: "audit the ledgers" },
    ]);
    expect(JSON.stringify(request.messages)).not.toContain("interjection");
    expect(request.messages[1]?.role).toBe("assistant");
  });

  it("renders the message as an ordinary user message: its sender line comes first", () => {
    const log = new Log();
    userMessage(log, [{ type: "text", text: "audit the ledgers" }], { name: "Ana", role: "admin" });
    log.runStarted();
    const first = step(log, 1);
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.");
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
    userMessage(log, [
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
    log.summary(first.result.seq, "The agent read ledger 1.");
    expect(mediaRefs(log.events, see)).toEqual([img]);
    // no row for the attachment here: the same placeholder an ordinary message gets
    const head = build(log, see).request.messages[0];
    expect(head?.content).toEqual([
      { type: "text", text: SUMMARY },
      { type: "text", text: "what is on this receipt?" },
      { type: "text", text: '[Attachment "receipt.png" is no longer available.]' },
    ]);
  });

  it("re-renders nothing for a run a finished background task woke (no message opened it)", () => {
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
    step(log, 2);
    log.summary(first.result.seq, "The agent read ledger 1.");
    const head = build(log).request.messages[0];
    expect(head?.content).toEqual([{ type: "text", text: SUMMARY }]);
  });
});
