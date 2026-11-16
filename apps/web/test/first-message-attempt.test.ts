// @vitest-environment jsdom
// The first send's attempt lifecycle (Task 10 slice C): a pure state machine, no React.
import { describe, expect, it } from "vitest";
import {
  type FirstMessageAttempt,
  failureOutcome,
  firstMessageIntent,
  isRecoverable,
  recoverableFor,
  retryFirstMessage,
  settleFirstMessage,
  startFirstMessage,
} from "../src/components/conversation/first-message-attempt";
import { ApiClientError } from "../src/lib/api";
import type { FirstMessageRequest } from "../src/lib/conversations";

const request = (over: Partial<FirstMessageRequest> = {}): FirstMessageRequest => ({
  agentId: "ag1",
  message: { text: "go" },
  permission: { profile: "approve-for-me" },
  deviceId: "d1",
  ...over,
});
const composed = { text: "go", clientMessageId: "draft-id" };
const network = () => new ApiClientError(0, "network", "Failed to fetch");
const conflict = () => new ApiClientError(409, "conflict", "Conflict");

describe("first-message intent: what makes it the same logical request", () => {
  it("ignores nothing the person chose: profile, consent, device, project, model and effort all count", () => {
    const base = firstMessageIntent("o1", request());
    expect(firstMessageIntent("o1", request())).toBe(base);
    const changes: FirstMessageRequest[] = [
      request({ permission: { profile: "request-approval" } }),
      request({ permission: { profile: "full-access", consentScopeRevision: "scope-2" } }),
      request({ deviceId: "d2" }),
      { agentId: "ag1", message: { text: "go" }, permission: { profile: "approve-for-me" } },
      request({ project: "core" }),
      request({ message: { text: "go", model: { provider: "p", model: "m" } } }),
      request({ message: { text: "go", effort: "high" } }),
      request({ message: { text: "go", skill: { name: "triage" } } }),
      request({ message: { text: "go", files: ["f1"] } }),
      request({ message: { text: "go!" } }),
      request({ agentId: "ag2" }),
    ];
    for (const changed of changes) expect(firstMessageIntent("o1", changed)).not.toBe(base);
    expect(firstMessageIntent("o2", request())).not.toBe(base);
    // empty lists are the same as none (the body leaves both out)
    expect(firstMessageIntent("o1", request({ message: { text: "go", files: [] } }))).toBe(base);
  });
});

describe("the attempt lifecycle", () => {
  const start = () => startFirstMessage("o1", request(), composed, "m1");

  it("freezes the id and the serialized bytes once; a retry sends the same ones", () => {
    const a = start();
    expect(a.state).toBe("sending");
    expect(a.clientMessageId).toBe("m1");
    expect(JSON.parse(a.serializedBody).message.clientMessageId).toBe("m1");
    const lost = settleFirstMessage(a, { error: network() });
    expect(lost.state).toBe("outcome-unknown");
    expect(lost.hadUnknownOutcome).toBe(true);
    const again = retryFirstMessage(lost);
    expect(again.state).toBe("sending");
    expect(again.serializedBody).toBe(a.serializedBody);
    expect(again.clientMessageId).toBe("m1");
    expect(again.hadUnknownOutcome).toBe(true);
  });

  it("classifies failures: no answer or a server error is unknown; a 4xx is a refusal", () => {
    expect(failureOutcome(network())).toBe("outcome-unknown");
    expect(failureOutcome(new ApiClientError(502, "http_error", "HTTP 502"))).toBe(
      "outcome-unknown",
    );
    expect(failureOutcome(new TypeError("boom"))).toBe("outcome-unknown");
    expect(failureOutcome(conflict())).toBe("rejected");
    expect(failureOutcome(new ApiClientError(400, "validation", "bad"))).toBe("rejected");
  });

  it("a conflict keeps the envelope and the earlier unknown outcome; it proves no rollback", () => {
    const lost = settleFirstMessage(start(), { error: network() });
    const refused = settleFirstMessage(retryFirstMessage(lost), { error: conflict() });
    expect(refused).toMatchObject({
      state: "rejected",
      conflict: true,
      hadUnknownOutcome: true,
      clientMessageId: "m1",
      serializedBody: lost.serializedBody,
    });
    expect(isRecoverable(refused)).toBe(true);
  });

  it("only unconfirmed or conflicted attempts stay recoverable", () => {
    const a = start();
    expect(isRecoverable(a)).toBe(false);
    expect(isRecoverable(settleFirstMessage(a, { error: conflict() }))).toBe(true);
    expect(
      isRecoverable(
        settleFirstMessage(a, { error: new ApiClientError(400, "validation", "bad request") }),
      ),
    ).toBe(false);
    const done = settleFirstMessage(a, { conversationId: "c9" });
    expect(done).toMatchObject({ state: "resolved", result: { conversationId: "c9" } });
    expect(isRecoverable(done)).toBe(false);
  });

  it("finds the recoverable attempt for an unchanged request, never for a changed one", () => {
    const lost = settleFirstMessage(start(), { error: network() });
    const other: FirstMessageAttempt = settleFirstMessage(
      startFirstMessage("o1", request({ deviceId: "d2" }), composed, "m2"),
      { error: network() },
    );
    const list = [lost, other];
    expect(recoverableFor(list, firstMessageIntent("o1", request()))).toBe(lost);
    expect(
      recoverableFor(
        list,
        firstMessageIntent("o1", request({ permission: { profile: "request-approval" } })),
      ),
    ).toBeUndefined();
  });
});
