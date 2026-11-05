import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { buildTimeline, type TimelineEntry, type Waiter } from "../src/lib/timeline";

/**
 * A shared conversation words a wait by who has to act (spec §6.16.9): the approval's assignee or
 * escalation role from `approval_requested`, the run's starter for a question or a connection.
 */

let t = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
}

const ME = "acc_me";
const NAMES: Record<string, string> = { acc_zhang: "张三" };
const whoWaits = (w: Waiter) =>
  w.kind === "role" ? `role:${w.role}` : w.accountId === ME ? undefined : NAMES[w.accountId];

const start = (by: string) =>
  ev(2, "run_started", {
    agentVersion: 1,
    model: { provider: "p", model: "m" },
    triggerAccountId: by,
  });
const call = (id: string, name: string) =>
  ev(3, "assistant_message", {
    step: 0,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id, name, input: {} }],
  });
const approval = (extra: Record<string, unknown>) =>
  ev(4, "approval_requested", {
    step: 0,
    callId: "a",
    approvalId: "ap1",
    toolKey: "Bash",
    expiresAt: "x",
    ...extra,
  });

const row = (out: TimelineEntry[]) => {
  const g = out.find((e) => e.kind === "tools");
  return g?.kind === "tools" ? g.rows[0]?.row : undefined;
};
const build = (events: ConversationEvent[]) =>
  buildTimeline(events, [], new Map(), "zh", { whoWaits });

describe("who a waiting call waits for", () => {
  it("an approval assigned to someone else names them, on the row and the card", () => {
    const out = build([
      start("acc_zhang"),
      call("a", "Bash"),
      approval({ requestedFor: "acc_zhang", approverRole: null }),
    ]);
    expect(row(out)).toMatchObject({ waiting: "approval", waitingFor: "张三" });
    const card = out.find((e) => e.kind === "approval");
    expect(card?.kind === "approval" && card.item.approver).toEqual({
      kind: "account",
      accountId: "acc_zhang",
    });
  });

  it("an approval assigned to the viewer reads 你 (no waitingFor)", () => {
    const out = build([
      start(ME),
      call("a", "Bash"),
      approval({ requestedFor: ME, approverRole: null }),
    ]);
    expect(row(out)?.waiting).toBe("approval");
    expect(row(out)?.waitingFor).toBeUndefined();
  });

  it("an approval escalated by role names the role", () => {
    const out = build([
      start(ME),
      call("a", "Bash"),
      approval({ requestedFor: null, approverRole: "admin" }),
    ]);
    expect(row(out)?.waitingFor).toBe("role:admin");
  });

  it("an older log without the approver keeps 你", () => {
    const out = build([start("acc_zhang"), call("a", "Bash"), approval({})]);
    expect(row(out)?.waiting).toBe("approval");
    expect(row(out)?.waitingFor).toBeUndefined();
  });

  it("a question waits for the run's starter", () => {
    const out = build([
      start("acc_zhang"),
      call("q", "AskUserQuestion"),
      ev(4, "question_asked", {
        step: 0,
        callId: "q",
        questionId: "q1",
        form: { fields: [] },
        expiresAt: "x",
      }),
    ]);
    expect(row(out)).toMatchObject({ waiting: "input", waitingFor: "张三" });
  });

  it("the name goes once the wait ends", () => {
    const out = build([
      start("acc_zhang"),
      call("a", "Bash"),
      approval({ requestedFor: "acc_zhang", approverRole: null }),
      ev(5, "approval_decided", {
        approvalId: "ap1",
        callId: "a",
        decision: "approved",
        byAccountId: "acc_zhang",
      }),
    ]);
    expect(row(out)?.waiting).toBeUndefined();
    expect(row(out)?.waitingFor).toBeUndefined();
  });

  it("a sub-agent's approval in the parent carries its approver", () => {
    const out = build([
      start("acc_zhang"),
      ev(4, "subagent_waiting", {
        subagentId: "sa1",
        childRunId: "cr1",
        kind: "approval",
        approvalId: "ap2",
        toolKey: "Bash",
        requestedFor: "acc_zhang",
        approverRole: null,
      }),
    ]);
    const w = out.find((e) => e.kind === "subagent-wait");
    expect(w?.kind === "subagent-wait" && w.approver).toEqual({
      kind: "account",
      accountId: "acc_zhang",
    });
  });
});
