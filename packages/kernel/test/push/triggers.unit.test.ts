import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import {
  conversationEventId,
  pushDeliverJobId,
  pushFanoutJobId,
  scheduleRunEventId,
} from "../../src/push/jobs.js";
import { pushTriggerOf } from "../../src/push/triggers.js";

/** The event rows of the Triggers table (plan task C7): event type -> category and text. */

const ev = (type: string, payload: unknown = {}) =>
  ({ type, payload }) as Pick<ConversationEvent, "type" | "payload">;

describe("pushTriggerOf", () => {
  it.each([
    ["approval_requested", { approvalId: "a" }, "waiting", "approval"],
    ["question_asked", { questionId: "q" }, "waiting", "question"],
    ["connection_required", { appId: "x" }, "waiting", "connect"],
    ["run_finished", { reason: "completed" }, "replies", "runFinished"],
    ["run_finished", { reason: "max_steps" }, "replies", "runFinished"],
    ["run_failed", { error: { code: "x", message: "m" } }, "replies", "runFailed"],
    ["background_task_finished", { status: "completed" }, "tasks", "backgroundFinished"],
    ["background_task_finished", { status: "failed" }, "tasks", "backgroundFinished"],
    ["subagent_finished", { status: "completed" }, "tasks", "subagentFinished"],
  ] as const)("%s -> %s", (type, payload, category, text) => {
    expect(pushTriggerOf(ev(type, payload))).toEqual({ category, text: text });
  });

  it.each([
    "run_aborted",
    "approval_decided",
    "subagent_waiting",
    "user_message",
    "assistant_message",
  ])("%s pushes nothing", (type) => {
    expect(pushTriggerOf(ev(type))).toBeNull();
  });

  it.each(["person", "deletion", "subagent_end"])(
    "a background task stopped by %s pushes nothing",
    (stoppedBy) => {
      expect(
        pushTriggerOf(ev("background_task_finished", { status: "stopped", stoppedBy })),
      ).toBeNull();
    },
  );
});

describe("push job ids", () => {
  const conv = "3f0c8a5e-2b1d-4c6e-9a7f-0d1e2f3a4b5c";
  const reg = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  it("contain no `:` for UUID inputs", () => {
    for (const eventId of [conversationEventId(conv, 42), scheduleRunEventId(conv)]) {
      expect(pushFanoutJobId(eventId)).not.toContain(":");
      expect(pushDeliverJobId(eventId, reg)).not.toContain(":");
    }
    expect(pushFanoutJobId(conversationEventId(conv, 42))).toBe(`push-fanout-conv-${conv}-42`);
    expect(pushDeliverJobId(scheduleRunEventId(conv), reg)).toBe(`push-sched-${conv}-${reg}`);
  });
});
