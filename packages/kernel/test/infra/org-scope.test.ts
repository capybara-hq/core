import { describe, expect, it } from "vitest";
import {
  asPlatform,
  bindRequestScope,
  currentScope,
  scopeKey,
  withOrgScope,
  withRequestScopeSlot,
} from "../../src/infra/database/org-scope.js";
import { runJob } from "../../src/infra/queue/run-job.js";

describe("org scope", () => {
  it("is unset outside any scope", () => {
    expect(currentScope()).toBeUndefined();
    expect(scopeKey(currentScope())).toBe("none");
  });

  it("withOrgScope and asPlatform nest and restore", async () => {
    await withOrgScope("o1", async () => {
      expect(scopeKey(currentScope())).toBe("org:o1");
      await asPlatform("sweep", async () => {
        await Promise.resolve();
        expect(currentScope()).toEqual({ kind: "platform", reason: "sweep" });
      });
      expect(scopeKey(currentScope())).toBe("org:o1");
    });
    expect(currentScope()).toBeUndefined();
  });

  it("refuses an empty org id or reason", () => {
    expect(() => withOrgScope("", () => 1)).toThrow();
    expect(() => asPlatform(" ", () => 1)).toThrow();
  });

  it("a request slot is empty until bound, then the whole request sees the scope", async () => {
    await withRequestScopeSlot(async () => {
      expect(currentScope()).toBeUndefined();
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      // a continuation registered before the bind
      const later = gate.then(() => scopeKey(currentScope()));
      bindRequestScope({ kind: "org", orgId: "o1" });
      open();
      await Promise.resolve();
      expect(scopeKey(currentScope())).toBe("org:o1");
      // continuations started before the bind share the slot
      expect(await later).toBe("org:o1");
      bindRequestScope({ kind: "org", orgId: "o1" });
      expect(() => bindRequestScope({ kind: "org", orgId: "o2" })).toThrow(/already scoped/);
      expect(() => bindRequestScope({ kind: "platform", reason: "x" })).toThrow(/already scoped/);
    });
  });

  it("binding outside a request slot or inside a fixed scope does nothing", () => {
    bindRequestScope({ kind: "org", orgId: "o1" });
    expect(currentScope()).toBeUndefined();
    withRequestScopeSlot(() =>
      asPlatform("fixed", () => {
        bindRequestScope({ kind: "org", orgId: "o1" });
        expect(currentScope()?.kind).toBe("platform");
      }),
    );
  });

  it("runJob scopes a job to its data's orgId, else to an explicit platform reason, else none", async () => {
    const seen = await withOrgScope("caller", () =>
      Promise.all([
        runJob("q", { id: "1", data: { orgId: "o9" } }, async () => currentScope()),
        runJob("q", { id: "2", data: { other: 1 } }, async () => currentScope()),
        runJob("q", { id: "3", data: { orgId: "" } }, async () => currentScope()),
        runJob("q", { id: "4", data: {} }, async () => currentScope(), { platform: "sweep" }),
        runJob("q", { id: "5", data: { orgId: "o8" } }, async () => currentScope(), {
          platform: "sweep",
        }),
      ]),
    );
    // never the caller's scope: a worker loop started in some scope does not lend it to jobs
    expect(seen.map(scopeKey)).toEqual(["org:o9", "none", "none", "platform", "org:o8"]);
    expect(seen[3]).toEqual({ kind: "platform", reason: "sweep" });
  });
});
