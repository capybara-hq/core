import { describe, expect, it, vi } from "vitest";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";

describe("KernelEvents", () => {
  it("a failing handler is logged with the payload's id and the next handler still runs", async () => {
    const log = { warn: vi.fn() };
    const events = new KernelEvents(log);
    const seen: string[] = [];
    events.on("approval.decided", () => {
      throw new Error("boom");
    });
    events.on("approval.decided", (a) => {
      seen.push(a.id);
    });
    events.on("question.answered", () => {
      throw new Error("boom");
    });
    const base = { orgId: "o", conversationId: "c", runId: "r" };
    await events.emit("approval.decided", { id: "a1", status: "approved", ...base });
    await events.emit("question.answered", { id: "q1", ...base });
    expect(seen).toEqual(["a1"]);
    expect(log.warn).toHaveBeenCalledWith(
      "kernel event handler failed",
      expect.objectContaining({ event: "approval.decided", approvalId: "a1" }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      "kernel event handler failed",
      expect.objectContaining({ event: "question.answered", questionId: "q1" }),
    );
  });
});
