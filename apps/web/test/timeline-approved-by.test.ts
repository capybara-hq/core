import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { buildTimeline, type TimelineEntry } from "../src/lib/timeline";

/**
 * Profiles govern every approval: an ask the profile decided without asking leaves a
 * `tool_ask_decided` event, which puts a neutral "approved by" fact on the call's row; a result
 * with a `reveal` view puts a reveal entry under the row, keyed by call.
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

const START = [
  ev(1, "user_message", { content: [{ type: "text", text: "go" }], authorAccountId: "a1" }, null),
  ev(2, "run_started", {
    model: { plugin: "p", model: "m" },
    triggerAccountId: "a1",
  }),
  ev(3, "assistant_message", {
    step: 0,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id: "k1", name: "Platform", input: { action: "call" } }],
  }),
];

const decided = (outcome: "allow" | "deny", decisionSource: "review-model" | "full-access") =>
  ev(4, "tool_ask_decided", {
    step: 0,
    callId: "k1",
    toolKey: "Platform:accounts.create",
    specHash: "s",
    bindingHash: "b",
    outcome,
    decisionSource,
    reason: "r",
    profileRevision: 1,
  });

const result = (view?: unknown, isError = false) =>
  ev(5, "tool_result", {
    step: 0,
    callId: "k1",
    toolKey: "Platform",
    content: "ok",
    isError,
    ...(view !== undefined ? { view } : {}),
  });

const build = (events: ConversationEvent[]) => buildTimeline(events, [], new Map(), "en");
const rows = (entries: TimelineEntry[]) =>
  entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));

describe("tool_ask_decided on the row", () => {
  it.each([
    ["full-access", "auto"],
    ["review-model", "review-model"],
  ] as const)("an allow by %s marks the row approved by %s", (source, by) => {
    const [row] = rows(build([...START, decided("allow", source), result()]));
    expect(row?.row.approvedBy).toBe(by);
  });

  it("a deny marks nothing as approved", () => {
    const [row] = rows(build([...START, decided("deny", "review-model"), result(undefined, true)]));
    expect(row?.row.approvedBy).toBeUndefined();
  });

  it("a call without the event carries no approvedBy", () => {
    const [row] = rows(build([...START, result()]));
    expect(row?.row.approvedBy).toBeUndefined();
  });
});

describe("reveal views", () => {
  it("a reveal result adds a reveal entry keyed by run and call, with the run's person", () => {
    const entries = build([...START, result({ kind: "reveal", reveal: "initial_password" })]);
    const reveal = entries.find((e) => e.kind === "reveal");
    expect(reveal).toMatchObject({
      kind: "reveal",
      callId: "k1",
      runId: "r1",
      reveal: "initial_password",
      starterAccountId: "a1",
    });
    expect(entries.indexOf(reveal as TimelineEntry)).toBe(
      entries.findIndex((e) => e.kind === "tools") + 1,
    );
  });

  it("a failed call or another view adds none", () => {
    expect(
      build([...START, result({ kind: "reveal", reveal: "invitation_link" }, true)]).some(
        (e) => e.kind === "reveal",
      ),
    ).toBe(false);
    expect(build([...START, result()]).some((e) => e.kind === "reveal")).toBe(false);
  });
});

describe("a consent approval then a secure input request on one call", () => {
  const requested = (seq: number, approvalId: string, extra: Record<string, unknown> = {}) =>
    ev(seq, "approval_requested", {
      step: 0,
      callId: "k1",
      approvalId,
      toolKey: "Platform:config.set",
      expiresAt: "2026-11-21T12:00:00.000Z",
      requestedFor: "a1",
      ...extra,
    });

  it("makes two distinct approval entries, only the second a secure input", () => {
    const entries = build([
      ...START,
      requested(4, "ap1"),
      ev(5, "approval_decided", {
        approvalId: "ap1",
        callId: "k1",
        decision: "approved",
        scope: "once",
        byAccountId: "a1",
      }),
      requested(6, "ap2", {
        secureInput: { target: { zh: "配置", en: "Config" }, fields: ["apiKey"] },
      }),
    ]);
    const approvals = entries.flatMap((e) => (e.kind === "approval" ? [e] : []));
    expect(approvals.map((a) => a.item.approvalId)).toEqual(["ap1", "ap2"]);
    expect(new Set(approvals.map((a) => a.key)).size).toBe(2);
    expect(approvals[0]?.item.decided?.decision).toBe("approved");
    expect(approvals[0]?.item.secureInput).toBeUndefined();
    expect(approvals[1]?.item.decided).toBeNull();
    expect(approvals[1]?.item.secureInput?.fields).toEqual(["apiKey"]);
  });
});
