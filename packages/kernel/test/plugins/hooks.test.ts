import { fileURLToPath } from "node:url";
import {
  definePlugin,
  type HookHandler,
  type HookOptions,
  type HookPayloads,
  type PluginManifest,
  PluginPermissionError,
  type ToolPreHookPayload,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createPluginContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { HookRegistry } from "../../src/plugins/hooks.js";
import { PluginHost } from "../../src/plugins/host.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: PluginHost[] = [];
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    runWorkers: false,
    log: quiet,
  };
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await sub.close();
  redis.disconnect();
  await deps.db.destroy();
  await Promise.all([pg.stop(), rd.stop()]);
});

const scope = {
  orgId: "org-1",
  accountId: "acc-1",
  agentId: "agent-1",
  agentVersion: 1,
  conversationId: "conv-1",
  runId: "run-1",
};
const toolPre = (input: unknown = { x: 1 }): ToolPreHookPayload => ({
  ...scope,
  step: 1,
  callId: "call-1",
  toolKey: "todo_add",
  specHash: "h1",
  input,
});

function registry(
  opts: { enabled?: string[]; timeoutMs?: number; log?: KernelDeps["log"] } = {},
): HookRegistry {
  return new HookRegistry({
    enabledPlugins: async () => new Set(opts.enabled ?? ["alpha", "zeta", "beta"]),
    redis,
    config: () => ({ hooks: { timeoutMs: opts.timeoutMs ?? 1000 } }),
    log: opts.log ?? quiet,
  });
}

const on = <K extends keyof HookPayloads>(
  r: HookRegistry,
  plugin: string,
  mount: K,
  handler: HookHandler<K>,
  opts: HookOptions,
) => r.add(plugin, mount, handler as HookHandler<keyof HookPayloads>, opts);

const signal = () => new AbortController().signal;

describe("HookRegistry.run", () => {
  it("runs by plugin name; the first policy deny stops the chain", async () => {
    const r = registry();
    const calls: string[] = [];
    on(
      r,
      "zeta",
      "tool.preExecute",
      () => {
        calls.push("zeta");
      },
      { mode: "policy" },
    );
    on(
      r,
      "alpha",
      "tool.preExecute",
      () => {
        calls.push("alpha");
        return { deny: "x" };
      },
      { mode: "policy" },
    );
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({
      allowed: false,
      plugin: "alpha",
      reason: "x",
      cause: "deny",
    });
    expect(calls).toEqual(["alpha"]);
  });

  it("all allow: every hook runs in plugin-name order", async () => {
    const r = registry();
    const calls: string[] = [];
    for (const p of ["zeta", "alpha", "beta"]) {
      on(
        r,
        p,
        "tool.preExecute",
        () => {
          calls.push(p);
        },
        { mode: "policy" },
      );
    }
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(calls).toEqual(["alpha", "beta", "zeta"]);
  });

  it("an observe hook returning deny is ignored and the chain continues", async () => {
    const r = registry();
    const zeta = vi.fn();
    on(r, "alpha", "tool.preExecute", () => ({ deny: "nope" }), { mode: "observe" });
    on(r, "zeta", "tool.preExecute", zeta, { mode: "policy" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(zeta).toHaveBeenCalledOnce();
  });

  it("a policy hook that throws denies with cause hook_error", async () => {
    const r = registry();
    on(
      r,
      "alpha",
      "model.request",
      () => {
        throw new Error("boom");
      },
      { mode: "policy" },
    );
    const out = await r.run(
      "model.request",
      {
        ...scope,
        step: 1,
        attempt: 1,
        provider: "p",
        model: "m",
        request: {
          model: "m",
          system: [],
          messages: [],
          tools: [],
          maxOutputTokens: 10,
          params: {},
        },
      },
      signal(),
    );
    expect(out).toMatchObject({ allowed: false, plugin: "alpha", cause: "hook_error" });
    expect(out.allowed === false && out.reason).toContain("boom");
  });

  it("a policy hook past hooks.timeoutMs denies with cause timeout and its signal aborts", async () => {
    const r = registry({ timeoutMs: 50 });
    let aborted = false;
    on(
      r,
      "alpha",
      "tool.preExecute",
      (_p, s) =>
        new Promise<void>((resolve) => {
          s.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      { mode: "policy" },
    );
    const out = await r.run("tool.preExecute", toolPre(), signal());
    expect(out).toMatchObject({ allowed: false, plugin: "alpha", cause: "timeout" });
    expect(aborted).toBe(true);
  });

  it("an observe hook that throws is allowed and warns once per plugin and mount per minute", async () => {
    const warn = vi.fn();
    const r = registry({ log: { ...quiet, warn } });
    const boom = () => {
      throw new Error("observe failed");
    };
    on(r, "alpha", "tool.preExecute", boom, { mode: "observe" });
    on(r, "alpha", "tool.postExecute", boom, { mode: "observe" });
    for (let i = 0; i < 3; i++) {
      expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ plugin: "alpha", mount: "tool.preExecute" });
    await r.run(
      "tool.postExecute",
      { ...toolPre(), isError: false, content: "ok", durationMs: 1 },
      signal(),
    );
    expect(warn).toHaveBeenCalledTimes(2);
    // the counter lives in Redis with a TTL of at most a minute (shared by replicas)
    const keys = await redis.keys("*hook-warn*");
    expect(keys.length).toBe(2);
    for (const k of keys) {
      const ttl = await redis.pttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    }
  });

  it("a plugin the organization has not enabled is not called", async () => {
    const r = registry({ enabled: ["zeta"] });
    const alpha = vi.fn(() => ({ deny: "x" }));
    on(r, "alpha", "tool.preExecute", alpha, { mode: "policy" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(alpha).not.toHaveBeenCalled();
  });

  it("the payload is a deep-frozen copy: mutating it is a hook_error (policy) or ignored (observe)", async () => {
    const original = toolPre({ nested: { x: 1 } });
    const mutate = (p: ToolPreHookPayload) => {
      (p.input as { nested: { x: number } }).nested.x = 2;
    };
    const policy = registry();
    on(policy, "alpha", "tool.preExecute", mutate, { mode: "policy" });
    const out = await policy.run("tool.preExecute", original, signal());
    expect(out).toMatchObject({ allowed: false, plugin: "alpha", cause: "hook_error" });
    const observe = registry();
    on(observe, "alpha", "tool.preExecute", mutate, { mode: "observe" });
    expect(await observe.run("tool.preExecute", original, signal())).toEqual({ allowed: true });
    expect(original.input).toEqual({ nested: { x: 1 } });
    expect(Object.isFrozen(original)).toBe(false);
  });

  it("no handlers: has() is false and run allows without querying the organization", async () => {
    const enabledPlugins = vi.fn(async () => new Set<string>());
    const r = new HookRegistry({
      enabledPlugins,
      redis,
      config: () => ({ hooks: { timeoutMs: 1000 } }),
      log: quiet,
    });
    expect(r.has("tool.preExecute")).toBe(false);
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(enabledPlugins).not.toHaveBeenCalled();
  });

  it("revoking removes the handler; has() turns false", () => {
    const r = registry();
    const revoke = on(r, "alpha", "tool.preExecute", () => {}, { mode: "observe" });
    expect(r.has("tool.preExecute")).toBe(true);
    revoke();
    expect(r.has("tool.preExecute")).toBe(false);
  });

  it("handlers('usage.report') lists handlers by plugin name", () => {
    const r = registry();
    const h = async () => {};
    on(r, "zeta", "usage.report", h, { mode: "observe" });
    on(r, "alpha", "usage.report", h, { mode: "observe" });
    expect(r.handlers("usage.report").map((x) => x.plugin)).toEqual(["alpha", "zeta"]);
  });
});

const manifest = (): PluginManifest =>
  definePlugin({
    name: "hooky",
    version: "0.1.0",
    sdk: "^0.1.0",
    provides: [],
    permissions: { hooks: ["tool.preExecute", "model.response", "session.start"] },
    setup() {},
  });

describe("ctx.hooks.on", () => {
  it("records the hook in the instance ledger; closing the ctx revokes it", async () => {
    const r = registry();
    const ctx = createPluginContext(deps, manifest(), undefined, undefined, r);
    ctx.hooks.on("tool.preExecute", () => {}, { mode: "policy" });
    ctx.sealTools();
    expect(ctx.ledger.list().map((x) => `${x.kind}:${x.key}`)).toEqual(["hook:tool.preExecute"]);
    expect(r.has("tool.preExecute")).toBe(true);
    await ctx.close();
    expect(r.has("tool.preExecute")).toBe(false);
  });

  it("throws for the four illegal uses", async () => {
    const r = registry();
    const ctx = createPluginContext(deps, manifest(), undefined, undefined, r);
    try {
      // not declared in permissions.hooks
      expect(() => ctx.hooks.on("tool.postExecute", () => {}, { mode: "observe" })).toThrow(
        PluginPermissionError,
      );
      // declared, but reserved (not in HOOKS_AVAILABLE)
      const reserved = () =>
        ctx.hooks.on("session.start" as "model.request", () => {}, { mode: "observe" });
      expect(reserved).toThrow(/not available/);
      expect(reserved).not.toThrow(PluginPermissionError);
      // policy on a mount point that cannot deny
      expect(() => ctx.hooks.on("model.response", () => {}, { mode: "policy" })).toThrow(/policy/);
      ctx.sealTools();
      // outside setup
      expect(() => ctx.hooks.on("tool.preExecute", () => {}, { mode: "observe" })).toThrow(
        /only allowed during setup/,
      );
      expect(r.has("tool.preExecute")).toBe(false);
      expect(r.has("model.response")).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

describe("plugin host", () => {
  it("unload and reload revoke the instance's hooks through the ledger", async () => {
    const h = new PluginHost(deps, {}, { autoApprove: true });
    hosts.push(h);
    await h.load([fx("hooks-a")]);
    expect(h.hooks.has("tool.preExecute")).toBe(true);
    expect(h.hooks.has("model.response")).toBe(true);
    expect(
      h
        .current("hooks-a")
        ?.registrations()
        .map((x) => `${x.kind}:${x.key}`),
    ).toEqual(["hook:tool.preExecute", "hook:model.response"]);

    await h.reload("hooks-a", { drainMs: 0 });
    // the new instance's hook answers (the old one's is revoked: see the unload below)
    const enabled = new Set(["hooks-a"]);
    vi.spyOn(h, "enabledPlugins").mockResolvedValue(enabled);
    expect(await h.hooks.run("tool.preExecute", toolPre({ deny: true }), signal())).toEqual({
      allowed: false,
      plugin: "hooks-a",
      reason: "blocked by hooks-a",
      cause: "deny",
    });

    await h.unload("hooks-a", { drainMs: 0 });
    expect(h.hooks.has("tool.preExecute")).toBe(false);
    expect(h.hooks.has("model.response")).toBe(false);
  });
});
