import { describe, expect, it } from "vitest";
import { accountIdsOfEvents } from "../../src/conversations/event-people.js";
import type { ConversationEvent } from "../../src/conversations/events.js";

const event = (seq: number, type: string, payload: Record<string, unknown>) =>
  ({
    seq,
    type,
    payload,
    conversationId: "c1",
    runId: null,
    createdAt: "2026-11-20T00:00:00Z",
  }) as unknown as ConversationEvent;

describe("accountIdsOfEvents", () => {
  it("names the accounts of authors, triggers, deciders and the approver an approval waits for", () => {
    const ids = accountIdsOfEvents([
      event(1, "user_message", { authorAccountId: "a1" }),
      event(2, "run_started", { triggerAccountId: "a2" }),
      event(3, "approval_requested", { requestedFor: "a3" }),
      event(4, "approval_decided", { byAccountId: "a4" }),
      event(5, "approval_requested", { requestedFor: null }),
      event(6, "subagent_waiting", { requestedFor: "a3" }),
    ]);
    expect([...ids].sort()).toEqual(["a1", "a2", "a3", "a4"]);
  });
});
