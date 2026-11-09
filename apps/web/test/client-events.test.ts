// Client events (client extensions spec §7.5): derived from the conversation log on the client.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CapybaraEvent,
  clientEventOf,
  createEventFeed,
  emitClientEvent,
  subscribeClientEvents,
} from "../src/components/client-ext/events";
import type { ConversationEvent } from "../src/lib/conversations";

const T = "2026-11-09T12:00:00.000Z";
const log = (seq: number, type: string, payload: unknown): ConversationEvent =>
  ({ conversationId: "c1", seq, runId: "r1", createdAt: T, type, payload }) as ConversationEvent;
const base = { conversationId: "c1", at: T };

describe("the log event to client event table", () => {
  const rows: [string, ConversationEvent, CapybaraEvent | null][] = [
    ["run_started", log(1, "run_started", {}), { type: "run.started", seq: 1, ...base }],
    [
      "run_finished",
      log(2, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }),
      { type: "run.finished", reason: "end_turn", seq: 2, ...base },
    ],
    [
      "run_aborted",
      log(3, "run_aborted", { byAccountId: null, reason: "user" }),
      { type: "run.finished", reason: "aborted", seq: 3, ...base },
    ],
    [
      "run_failed",
      log(4, "run_failed", { error: { code: "model.unavailable", message: "x" } }),
      { type: "run.failed", code: "model.unavailable", seq: 4, ...base },
    ],
    [
      "user_message",
      log(5, "user_message", { content: [], authorAccountId: "a1" }),
      { type: "message.sent", seq: 5, ...base },
    ],
    [
      "user_message with dispatch (a parent agent's)",
      log(6, "user_message", {
        content: [],
        authorAccountId: "a1",
        dispatch: { parentConversationId: "p", parentRunId: "r", callId: "k" },
      }),
      null,
    ],
    [
      "assistant_message",
      log(7, "assistant_message", { content: [] }),
      { type: "message.received", seq: 7, ...base },
    ],
    [
      "tool_call_started",
      log(8, "tool_call_started", { step: 1, callId: "k1", toolKey: "Bash", specHash: "h" }),
      { type: "tool.started", callId: "k1", tool: "Bash", seq: 8, ...base },
    ],
    [
      "tool_result",
      log(9, "tool_result", { step: 1, callId: "k1", toolKey: "Bash", content: "", isError: true }),
      { type: "tool.finished", callId: "k1", tool: "Bash", isError: true, seq: 9, ...base },
    ],
    [
      "approval_requested",
      log(10, "approval_requested", { step: 1, callId: "k2", approvalId: "ap", toolKey: "Bash" }),
      { type: "approval.requested", callId: "k2", seq: 10, ...base },
    ],
    ["an event with no client event", log(11, "model_switched", {}), null],
  ];
  it.each(rows)("%s", (_name, event, expected) => {
    expect(clientEventOf(event)).toEqual(expected);
  });

  it("payloads carry no content, tool input or output", () => {
    const e = clientEventOf(
      log(9, "tool_result", {
        step: 1,
        callId: "k",
        toolKey: "Bash",
        content: "secret",
        isError: false,
      }),
    );
    expect(JSON.stringify(e)).not.toContain("secret");
  });
});

describe("the event feed", () => {
  const collect = () => {
    const seen: CapybaraEvent[] = [];
    return { seen, feed: createEventFeed((e) => seen.push(e)) };
  };
  const started = (seq: number) => log(seq, "run_started", {});

  it("history loaded on open emits nothing", () => {
    const { seen, feed } = collect();
    feed.observe([started(1), log(2, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 })]);
    expect(seen).toEqual([]);
    // the same list again (a re-render) is still nothing
    feed.observe([started(1), log(2, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 })]);
    expect(seen).toEqual([]);
  });

  it("an empty log on open is a baseline too: the first appended event emits", () => {
    const { seen, feed } = collect();
    feed.observe([]);
    feed.observe([log(1, "user_message", { content: [], authorAccountId: "a1" })]);
    expect(seen.map((e) => e.type)).toEqual(["message.sent"]);
  });

  it("an earlier page of history prepended later emits nothing", () => {
    const { seen, feed } = collect();
    feed.observe([started(5)]);
    feed.observe([started(3), started(4), started(5)]);
    expect(seen).toEqual([]);
  });

  it("a reconnect catch-up emits each event once by seq", () => {
    const { seen, feed } = collect();
    feed.observe([started(1)]);
    feed.observe([started(1), log(2, "assistant_message", { content: [] })]);
    // the catch-up delivers 2 again and then 3 and 4: 2 is not repeated
    feed.observe([
      started(1),
      log(2, "assistant_message", { content: [] }),
      log(3, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }),
      started(4),
    ]);
    expect(seen.map((e) => [e.seq, e.type])).toEqual([
      [2, "message.received"],
      [3, "run.finished"],
      [4, "run.started"],
    ]);
  });
});

describe("delivery", () => {
  const unsubs: (() => void)[] = [];
  afterEach(() => {
    for (const u of unsubs.splice(0)) u();
  });
  const event: CapybaraEvent = { type: "run.started", seq: 1, ...base };

  it("is asynchronous: a microtask after the emit", async () => {
    const got = vi.fn();
    unsubs.push(subscribeClientEvents(got));
    emitClientEvent(event);
    expect(got).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(got).toHaveBeenCalledWith(event);
  });

  it("a throwing listener does not stop the next", async () => {
    const failed = vi.fn();
    const next = vi.fn();
    unsubs.push(
      subscribeClientEvents(() => {
        throw new Error("boom");
      }, failed),
    );
    unsubs.push(subscribeClientEvents(next));
    emitClientEvent(event);
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(event);
  });

  it("an unsubscribed listener hears nothing", async () => {
    const got = vi.fn();
    subscribeClientEvents(got)();
    emitClientEvent(event);
    await Promise.resolve();
    expect(got).not.toHaveBeenCalled();
  });
});
