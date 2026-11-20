import {
  checkPushResults,
  PushError,
  type PushMessage,
  type PushProvider,
  type PushResult,
  type PushTarget,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/** What the vendor does for one token. */
export type PushOutcome =
  | "delivered"
  | "unregistered"
  | "auth"
  | "rate_limited"
  | "transient"
  | "network_error"
  | "hang";

/** A vendor request as the suite checks it (what reached the vendor, not what the provider was given). */
export interface PushVendorRequest {
  token: string;
  title: string;
  body: string;
  path: string;
  origin: string;
  threadId: string;
}

/** The provider under test and its (fake) vendor. */
export interface PushConformanceTarget {
  /** The plugin name. */
  plugin: string;
  make(): Promise<{
    provider: PushProvider;
    /** Makes the vendor answer `outcome` for `token`. */
    arrange(token: string, outcome: PushOutcome): void;
    /** Every request that reached the vendor. */
    requests(): PushVendorRequest[];
    close(): Promise<void>;
  }>;
}

const MESSAGE: PushMessage = {
  title: "Support agent",
  body: "needs your approval",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  origin: "https://capybara.example.com",
};

const APP_ID = "com.example.app";

const secretToken = (n: string) => `SECRET-TOKEN-${n}-do-not-leak`;

const target1 = (id: string, token: string): PushTarget => ({
  id,
  platform: "ios",
  appId: APP_ID,
  token,
});

type Settled = { kind: "results"; results: PushResult[] } | { kind: "threw"; error: unknown };

/**
 * Runs the `push-provider@1` conformance suite against one provider and its fake vendor. The suite
 * never sleeps: `hang` settles on the signal's abort event.
 */
export function describePushProviderConformance(t: PushConformanceTarget): void {
  describe(`push provider conformance: ${t.plugin}`, () => {
    async function run(
      outcome: PushOutcome,
      fn: (ctx: {
        settled: Settled;
        token: string;
        requests: PushVendorRequest[];
      }) => void | Promise<void>,
    ) {
      const h = await t.make();
      try {
        const token = secretToken(outcome);
        h.arrange(token, outcome);
        let settled: Settled;
        const ac = new AbortController();
        if (outcome === "hang") queueMicrotask(() => ac.abort());
        try {
          settled = {
            kind: "results",
            results: await h.provider.send({
              registrations: [target1("r1", token)],
              message: MESSAGE,
              signal: ac.signal,
            }),
          };
        } catch (error) {
          settled = { kind: "threw", error };
        }
        await fn({ settled, token, requests: h.requests() });
      } finally {
        await h.close();
      }
    }

    /** The one outcome of a call: a result for r1, or the kind of a thrown PushError. */
    const outcomeOf = (s: Settled): { status: string; kind?: string } => {
      if (s.kind === "threw") {
        if (s.error instanceof PushError) return { status: "failed", kind: s.error.kind };
        throw s.error;
      }
      expect(checkPushResults([target1("r1", "x")], s.results)).toBeNull();
      const r = s.results[0] as PushResult;
      return r.status === "failed" ? { status: "failed", kind: r.kind } : { status: r.status };
    };

    it("delivered answers delivered and the vendor request carries exactly the message", async () => {
      await run("delivered", ({ settled, token, requests }) => {
        expect(settled).toEqual({
          kind: "results",
          results: [{ registrationId: "r1", status: "delivered" }],
        });
        expect(requests).toEqual([{ token, ...MESSAGE }]);
      });
    });

    it("unregistered answers unregistered", async () => {
      await run("unregistered", ({ settled }) => {
        expect(outcomeOf(settled)).toEqual({ status: "unregistered" });
      });
    });

    it.each(["auth", "rate_limited", "transient"] as const)(
      "%s answers failed with that kind",
      async (outcome) => {
        await run(outcome, ({ settled }) => {
          expect(outcomeOf(settled)).toEqual({ status: "failed", kind: outcome });
        });
      },
    );

    it("a network error yields transient", async () => {
      await run("network_error", ({ settled }) => {
        if (settled.kind === "threw") {
          expect(settled.error).toBeInstanceOf(PushError);
          expect((settled.error as PushError).kind).toBe("transient");
        } else {
          expect(outcomeOf(settled)).toEqual({ status: "failed", kind: "transient" });
        }
      });
    });

    it.each([
      "delivered",
      "unregistered",
      "auth",
      "rate_limited",
      "transient",
      "network_error",
    ] as const)("%s is requested exactly once (no retries inside)", async (outcome) => {
      await run(outcome, ({ requests, token }) => {
        expect(requests.filter((r) => r.token === token)).toHaveLength(1);
      });
    });

    it("two registrations in one call get two results", async () => {
      const h = await t.make();
      try {
        const regs = [target1("r1", secretToken("a")), target1("r2", secretToken("b"))];
        for (const r of regs) h.arrange(r.token, "delivered");
        const results = await h.provider.send({
          registrations: regs,
          message: MESSAGE,
          signal: new AbortController().signal,
        });
        expect(checkPushResults(regs, results)).toBeNull();
        expect(results).toHaveLength(2);
      } finally {
        await h.close();
      }
    });

    it("hang with an aborted signal settles without a timer", async () => {
      await run("hang", ({ settled }) => {
        if (settled.kind === "threw") return;
        expect(outcomeOf(settled)).toEqual({ status: "failed", kind: "transient" });
      });
    });

    it.each([
      "unregistered",
      "auth",
      "rate_limited",
      "transient",
      "network_error",
      "hang",
    ] as const)("%s leaks no token in a message", async (outcome) => {
      await run(outcome, ({ settled, token }) => {
        const messages =
          settled.kind === "threw"
            ? [settled.error instanceof Error ? settled.error.message : String(settled.error)]
            : settled.results.flatMap((r) => (r.status === "failed" ? [r.message] : []));
        for (const m of messages) expect(m).not.toContain(token);
      });
    });

    it("apps() returns the same array twice and does not touch the vendor", async () => {
      const h = await t.make();
      try {
        const first = h.provider.apps();
        expect(h.provider.apps()).toBe(first);
        expect(Array.isArray(first)).toBe(true);
        expect(h.requests()).toEqual([]);
      } finally {
        await h.close();
      }
    });
  });
}
