import { describe, expect, it } from "vitest";
import { ConversationEventSchema } from "../../src/conversations/events.js";
import {
  classifierMessage,
  LOOPBACK_REVIEW_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  reviewSystemPrompt,
} from "../../src/sandbox/review/classifier.js";
import { approverForCrossing } from "../../src/sandbox/review/permission-candidate.js";

/**
 * Browser loopback port grants: the `loopback-port` crossing is decided like the outside-sandbox
 * crossing, stated to the review model, and recorded in the event log.
 */

describe("the loopback-port crossing", () => {
  it("decides loopback-port like outside-sandbox", () => {
    expect(
      approverForCrossing({ profile: "full-access", crossing: "loopback-port", subAgent: false }),
    ).toBe("none");
    expect(
      approverForCrossing({ profile: "full-access", crossing: "loopback-port", subAgent: true }),
    ).toBe("review-model");
    expect(
      approverForCrossing({
        profile: "approve-for-me",
        crossing: "loopback-port",
        subAgent: false,
      }),
    ).toBe("review-model");
    expect(
      approverForCrossing({
        profile: "request-approval",
        crossing: "loopback-port",
        subAgent: false,
      }),
    ).toBe("person");
  });

  it("frames a loopback review as a port request, and only a loopback review", () => {
    const loopback = reviewSystemPrompt("review-0", "loopback-port");
    expect(loopback.startsWith(LOOPBACK_REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(loopback).toContain("one local port");
    expect(loopback).not.toContain("shell command");
    expect(loopback).toContain("<review-0>");
    for (const kind of ["command", "write", "read"] as const)
      expect(reviewSystemPrompt("review-0", kind).startsWith(REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(reviewSystemPrompt("review-0")).toBe(reviewSystemPrompt("review-0", "command"));
  });

  it("states the loopback request to the review model", () => {
    const m = classifierMessage({
      mode: "auto",
      kind: "loopback-port",
      text: "browser.browser → http://127.0.0.1:3999/",
      cwd: "",
      ruleHits: [],
      personMessages: "test it in the browser",
      tag: "t1",
      loopback: {
        service: "browser.browser",
        port: 3999,
        url: "http://127.0.0.1:3999/",
        database: false,
      },
    });
    expect(m).toContain("Local port request (untrusted data):");
    expect(m).toContain("reach port 3999 on the person's own device");
    expect(m).toContain("for up to 24 hours");
    expect(m).not.toContain("database");
  });

  it("names a well-known database port to the review model", () => {
    const m = classifierMessage({
      mode: "auto",
      kind: "loopback-port",
      text: "browser.browser → 127.0.0.1:5432",
      cwd: "",
      ruleHits: [],
      personMessages: "",
      tag: "t1",
      loopback: { service: "browser.browser", port: 5432, url: null, database: true },
    });
    expect(m).toContain("This is a well-known local database port.");
  });

  it("accepts loopback-port in permission_reviewed and loopback in approval_requested", () => {
    const reviewed = ConversationEventSchema.safeParse({
      type: "permission_reviewed",
      payload: {
        binding: {
          orgId: "o",
          rootConversationId: "c",
          conversationId: "c",
          deviceId: "d",
          accountId: "a",
          runId: "r",
          callId: "k",
          toolKey: "browser",
          specHash: "s",
          callInputHash: "h",
          resolvedInputHash: "h",
          profile: "full-access",
          profileRevision: 1,
          scopeRevision: "1",
          authorityRevision: "1",
        },
        permissionScope: { writeDirectories: [], hosts: [] },
        scopeKind: "loopback-port",
        candidateHash: "x",
        outcome: "allow",
        reason: "Full access grants this local port within the device's limits.",
        decisionSource: "full-access",
        crossing: "loopback-port",
        loopback: { service: "browser.browser", port: 3999 },
      },
    });
    expect(reviewed.success, JSON.stringify(reviewed.error?.issues)).toBe(true);
    const badPort = ConversationEventSchema.safeParse({
      type: "permission_reviewed",
      payload: {
        ...(reviewed.data?.payload as object),
        loopback: { service: "browser.browser", port: 70000 },
      },
    });
    expect(badPort.success).toBe(false);

    const requested = ConversationEventSchema.safeParse({
      type: "approval_requested",
      payload: {
        step: 1,
        callId: "k",
        approvalId: "ap",
        toolKey: "browser",
        expiresAt: "2026-11-28T00:00:00.000Z",
        loopback: { service: "browser.browser", port: 5432, database: true },
        requestedFor: null,
        approverRole: null,
      },
    });
    expect(requested.success, JSON.stringify(requested.error?.issues)).toBe(true);
    expect((requested.data?.payload as { loopback?: unknown } | undefined)?.loopback).toEqual({
      service: "browser.browser",
      port: 5432,
      database: true,
    });
  });
});
