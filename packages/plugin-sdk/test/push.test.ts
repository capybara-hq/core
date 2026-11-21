import { describe, expect, expectTypeOf, it } from "vitest";
import {
  checkPushResults,
  EXTENSION_POINTS,
  PUSH_LIMITS,
  PUSH_PROVIDER_EXTENSION_POINT,
  type PushCapabilityV1,
  PushError,
  type PushMessage,
  type PushRegistration,
  type PushTarget,
  SHELL_CAPABILITY_KEYS,
  validatePushMessage,
} from "../src/index.js";

const target = (id: string): PushTarget => ({
  id,
  platform: "ios",
  appId: "com.example.app",
  token: `secret-token-${id}`,
});
const message: PushMessage = {
  title: "t",
  body: "b",
  path: "/chat/1",
  threadId: "c1",
  collapseId: "conv-c1-7",
  origin: "https://cap.example.com",
};

describe("push-provider@1", () => {
  it("is registered", () => {
    expect(PUSH_PROVIDER_EXTENSION_POINT).toBe("push-provider@1");
    expect(EXTENSION_POINTS["push-provider"]).toMatchObject({
      majors: [1],
      cardinality: "multi",
      brokered: true,
      orgScoped: false,
    });
  });

  it("has the limits", () => {
    expect(PUSH_LIMITS.titleChars).toBe(100);
    expect(PUSH_LIMITS.bodyChars).toBe(240);
    expect(PUSH_LIMITS.collapseIdChars).toBe(64);
  });

  it("PushError keeps its fields", () => {
    const e = new PushError("x", { kind: "rate_limited", retryAfterMs: 5000 });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(5000);
  });

  it("checkPushResults accepts one result per target", () => {
    const ts = [target("a"), target("b")];
    expect(
      checkPushResults(ts, [
        { registrationId: "a", status: "delivered" },
        { registrationId: "b", status: "unregistered" },
      ]),
    ).toBeNull();
    expect(
      checkPushResults(ts, [
        { registrationId: "a", status: "failed", kind: "auth", message: "m" },
        { registrationId: "b", status: "delivered" },
      ]),
    ).toBeNull();
  });

  it("checkPushResults names the problem without a token", () => {
    const ts = [target("a"), target("b")];
    const ok = { registrationId: "a", status: "delivered" };
    const bad: unknown[] = [
      [ok],
      [ok, ok],
      [ok, { registrationId: "zzz", status: "delivered" }],
      "nope",
      [ok, { registrationId: "b", status: "failed", kind: "weird", message: "m" }],
      [ok, { registrationId: "b", status: "failed", message: "m" }],
    ];
    for (const r of bad) {
      const p = checkPushResults(ts, r);
      expect(p).toEqual(expect.any(String));
      expect(p).not.toContain("secret-token");
    }
  });

  it("validatePushMessage", () => {
    expect(validatePushMessage(message)).toBeNull();
    expect(validatePushMessage({ ...message, title: "x".repeat(101) })).toMatch(/title/);
    expect(validatePushMessage({ ...message, body: "x".repeat(241) })).toMatch(/body/);
    expect(validatePushMessage({ ...message, path: "chat" })).toMatch(/path/);
    expect(validatePushMessage({ ...message, origin: "https://a.com/x" })).toMatch(/origin/);
    expect(validatePushMessage({ ...message, collapseId: "x".repeat(64) })).toBeNull();
    for (const collapseId of ["", "x".repeat(65), "conv:1", "a b", "é"]) {
      expect(validatePushMessage({ ...message, collapseId })).toMatch(/collapseId/);
    }
  });
});

describe("push@1 shell capability", () => {
  it("has its key and types", () => {
    expect(SHELL_CAPABILITY_KEYS.push).toBe("push@1");
    expectTypeOf<PushCapabilityV1["register"]>().returns.resolves.toEqualTypeOf<PushRegistration>();
  });
});
