import { PushError, type PushMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { makeFakePush } from "../fixtures/extensions/fake-push/src/push.js";
import {
  describePushProviderConformance,
  type PushConformanceTarget,
  type PushOutcome,
} from "../src/index.js";

const PREFIX: Record<PushOutcome, string> = {
  delivered: "ok:",
  unregistered: "dead:",
  auth: "auth:",
  rate_limited: "rate:",
  transient: "flaky:99:",
  network_error: "net:",
  hang: "hang:",
};

/** The suite against `fake-push`: outcomes map to token prefixes, the vendor is its in-process probe. */
const target: PushConformanceTarget = {
  plugin: "fake-push",
  async make() {
    const fake = makeFakePush({ apps: ["com.example.app"] });
    const overrides = new Map<string, string>();
    const original = new Map<string, string>();
    const prefixed = (token: string) => {
      const p = `${overrides.get(token) ?? ""}${token}`;
      original.set(p, token);
      return p;
    };
    return {
      provider: {
        apps: () => fake.provider.apps(),
        send: (args) =>
          fake.provider.send({
            ...args,
            registrations: args.registrations.map((r) => ({ ...r, token: prefixed(r.token) })),
          }),
      },
      arrange(token, outcome) {
        overrides.set(token, PREFIX[outcome]);
      },
      requests: () =>
        fake.sends.map((s) => ({
          token: original.get(s.token) ?? s.token,
          title: s.message.title,
          body: s.message.body,
          path: s.message.path,
          origin: s.message.origin,
          threadId: s.message.threadId,
          collapseId: s.message.collapseId,
        })),
      async close() {},
    };
  },
};

describePushProviderConformance(target);

describe("fake-push", () => {
  const message: PushMessage = {
    title: "t",
    body: "b",
    path: "/chat/1",
    threadId: "th",
    collapseId: "conv-th-1",
    origin: "https://x.example",
  };
  const reg = (id: string, token: string) => ({
    id,
    platform: "ios" as const,
    appId: "com.example.app",
    token,
  });
  const send = (fake: ReturnType<typeof makeFakePush>, token: string) =>
    fake.provider.send({
      registrations: [reg("r1", token)],
      message,
      signal: new AbortController().signal,
    });

  it("scripts the rate limit with retryAfterMs 1000", async () => {
    const r = await send(makeFakePush(), "rate:x");
    expect(r).toEqual([
      expect.objectContaining({ status: "failed", kind: "rate_limited", retryAfterMs: 1000 }),
    ]);
  });

  it("flaky:<n>: is transient for the first n calls of that token, then delivered", async () => {
    const fake = makeFakePush();
    const kinds = [];
    for (let i = 0; i < 3; i++) kinds.push((await send(fake, "flaky:2:abc"))[0]?.status);
    expect(kinds).toEqual(["failed", "failed", "delivered"]);
  });

  it("throws a plain Error for throw: and a configured app list from apps()", async () => {
    const fake = makeFakePush({ apps: ["a.b"] });
    await expect(send(fake, "throw:x")).rejects.not.toBeInstanceOf(PushError);
    expect(fake.provider.apps()).toEqual(["a.b"]);
  });
});
