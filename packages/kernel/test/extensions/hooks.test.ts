import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import {
  type AvailableHook,
  defineExtension,
  type ExtensionManifest,
  ExtensionPermissionError,
  type HookHandler,
  type HookOptions,
  type HookPayloads,
  type ModelRequestHookPayload,
  type ToolPreHookPayload,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createExtensionContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  EMPTY_DENY_REASON,
  errMsg,
  HOOK_DETAIL_MAX_CHARS,
  HOOK_REASON_MAX_CHARS,
  HookRegistry,
  type HookSource,
  OBSERVE_INFLIGHT_MAX,
  type RegisteredHook,
  sanitizeDenyReason,
} from "../../src/extensions/hooks.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { InflightTracker } from "../../src/extensions/inflight.js";
import type { HooksDrainState } from "../fixtures/plugins/hooks-drain/index.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: ExtensionHost[] = [];
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
const modelReq = (): ModelRequestHookPayload => ({
  ...scope,
  purpose: "step",
  step: 1,
  attempt: 1,
  provider: "p",
  model: "m",
  request: { model: "m", system: [], messages: [], tools: [], maxOutputTokens: 10, params: {} },
});

/** A fake plugin instance: hooks and an in-flight tracker. */
class Src implements HookSource {
  readonly hooks: RegisteredHook[] = [];
  readonly inflight: InflightTracker;
  constructor(readonly name: string) {
    this.inflight = new InflightTracker(name);
  }
  on<K extends AvailableHook>(mount: K, handler: HookHandler<K>, opts: HookOptions): this {
    this.hooks.push({ mount, handler: handler as HookHandler<AvailableHook>, mode: opts.mode });
    return this;
  }
}

function setup(
  opts: {
    enabled?: string[] | (() => Promise<Set<string>>);
    timeoutMs?: number;
    log?: KernelDeps["log"];
    /** Deployment state: plugin → mounts with policy hooks (M-1). */
    expected?: Record<string, string[]>;
  } = {},
) {
  const sources: Src[] = [];
  const current = new Map<string, Src>();
  const enabled = opts.enabled;
  const r = new HookRegistry({
    instances: () => sources,
    current: (p) => current.get(p),
    expectedPolicy: (mount) =>
      Object.entries(opts.expected ?? {}).flatMap(([p, ms]) => (ms.includes(mount) ? [p] : [])),
    enabledPlugins:
      typeof enabled === "function"
        ? enabled
        : async () => new Set(enabled ?? ["alpha", "beta", "zeta"]),
    redis,
    config: () => ({ hooks: { timeoutMs: opts.timeoutMs ?? 1000 } }),
    log: opts.log ?? quiet,
  });
  const plugin = (name: string) => {
    const s = new Src(name);
    sources.push(s);
    current.set(name, s);
    return s;
  };
  const remove = (s: Src) => {
    sources.splice(sources.indexOf(s), 1);
    if (current.get(s.name) === s) current.delete(s.name);
  };
  return { r, plugin, remove, current, sources };
}

const signal = () => new AbortController().signal;
const warnSpy = () => {
  const warn = vi.fn();
  return { warn, log: { ...quiet, warn } };
};

describe("HookRegistry.run: policy hooks", () => {
  it("run serially by plugin name; the first deny stops the chain", async () => {
    const { r, plugin } = setup();
    const calls: string[] = [];
    plugin("zeta").on("tool.preExecute", () => void calls.push("zeta"), { mode: "policy" });
    plugin("alpha").on(
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

  it("all allow: every hook runs, by plugin name, registration order within a plugin", async () => {
    const { r, plugin } = setup();
    const calls: string[] = [];
    const rec = (s: string) => () => void calls.push(s);
    plugin("zeta").on("tool.preExecute", rec("zeta"), { mode: "policy" });
    plugin("alpha")
      .on("tool.preExecute", rec("alpha-1"), { mode: "policy" })
      .on("tool.preExecute", rec("alpha-2"), { mode: "policy" });
    plugin("beta").on("tool.preExecute", rec("beta"), { mode: "policy" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(calls).toEqual(["alpha-1", "alpha-2", "beta", "zeta"]);
  });

  it("a throwing policy hook denies with a generic reason; the raw error is only in detail and the log", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ log });
    plugin("alpha").on(
      "model.request",
      () => {
        throw new Error("secret internals");
      },
      { mode: "policy" },
    );
    const out = await r.run("model.request", modelReq(), signal());
    expect(out).toEqual({
      allowed: false,
      plugin: "alpha",
      reason: "The alpha policy check failed",
      cause: "hook_error",
      detail: "secret internals",
    });
    expect(JSON.stringify(warn.mock.calls)).toContain("secret internals");
  });

  it("a policy hook past hooks.timeoutMs denies (timeout, generic reason) and its signal aborts", async () => {
    const { r, plugin } = setup({ timeoutMs: 50 });
    let aborted = false;
    plugin("alpha").on(
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
    expect(out).toMatchObject({
      allowed: false,
      plugin: "alpha",
      cause: "timeout",
      reason: "The alpha policy check did not respond in time",
    });
    expect(aborted).toBe(true);
  });

  it("deny reasons are sanitized for the model", async () => {
    const { r, plugin } = setup();
    plugin("alpha").on("tool.preExecute", () => ({ deny: "  no\n\tway\u0007 \u0000 here " }), {
      mode: "policy",
    });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toMatchObject({
      reason: "no way here",
      cause: "deny",
    });
  });

  it("a plugin the organization has not enabled is not called", async () => {
    const { r, plugin } = setup({ enabled: ["zeta"] });
    const alpha = vi.fn(() => ({ deny: "x" }));
    plugin("alpha").on("tool.preExecute", alpha, { mode: "policy" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(alpha).not.toHaveBeenCalled();
  });

  it("the payload is a deep-frozen copy: mutating it is a hook_error", async () => {
    const original = toolPre({ nested: { x: 1 } });
    const { r, plugin } = setup();
    plugin("alpha").on(
      "tool.preExecute",
      (p) => {
        (p.input as { nested: { x: number } }).nested.x = 2;
      },
      { mode: "policy" },
    );
    expect(await r.run("tool.preExecute", original, signal())).toMatchObject({
      allowed: false,
      cause: "hook_error",
    });
    expect(original.input).toEqual({ nested: { x: 1 } });
    expect(Object.isFrozen(original)).toBe(false);
  });

  it("a hook cut off by revocation reruns once on the current generation", async () => {
    const { r, plugin, current, remove } = setup();
    const old = plugin("alpha");
    old.on("tool.preExecute", () => new Promise<void>(() => {}), { mode: "policy" });
    const running = r.run("tool.preExecute", toolPre(), signal());
    await vi.waitFor(() => expect(old.inflight.size).toBe(1));
    // upgrade: the new generation replaces the old one, which is then aborted
    remove(old);
    const next = plugin("alpha");
    next.on("tool.preExecute", () => ({ deny: "from the new generation" }), { mode: "policy" });
    expect(current.get("alpha")).toBe(next);
    old.inflight.abort();
    expect(await running).toMatchObject({ reason: "from the new generation", cause: "deny" });
  });

  it("a hook cut off by revocation with no current generation denies", async () => {
    const { r, plugin, remove } = setup();
    const old = plugin("alpha");
    old.on("tool.preExecute", () => new Promise<void>(() => {}), { mode: "policy" });
    const running = r.run("tool.preExecute", toolPre(), signal());
    await vi.waitFor(() => expect(old.inflight.size).toBe(1));
    remove(old);
    old.inflight.abort();
    expect(await running).toMatchObject({
      allowed: false,
      plugin: "alpha",
      cause: "hook_error",
      reason: "The alpha policy check failed",
    });
  });
});

describe("HookRegistry.run: observe hooks", () => {
  it("are fire-and-forget: run never waits for them, and they run even when the call is denied", async () => {
    const { r, plugin } = setup();
    let release: () => void = () => {};
    const observed: string[] = [];
    plugin("alpha").on(
      "tool.preExecute",
      () =>
        new Promise<void>((resolve) => {
          observed.push("alpha");
          release = resolve;
        }),
      { mode: "observe" },
    );
    plugin("beta").on("tool.preExecute", () => ({ deny: "no" }), { mode: "policy" });
    plugin("zeta").on("tool.preExecute", () => ({ deny: "ignored" }), { mode: "observe" });
    const out = await r.run("tool.preExecute", toolPre(), signal());
    expect(out).toMatchObject({ allowed: false, plugin: "beta", reason: "no" });
    await vi.waitFor(() => expect(observed).toEqual(["alpha"]));
    release();
  });

  it("a throwing observe hook warns once per plugin and mount per minute (Redis TTL)", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ log });
    const boom = () => {
      throw new Error("observe failed");
    };
    plugin("alpha")
      .on("tool.preExecute", boom, { mode: "observe" })
      .on("tool.postExecute", boom, { mode: "observe" });
    for (let i = 0; i < 3; i++) {
      expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    }
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ plugin: "alpha", mount: "tool.preExecute" });
    await r.run(
      "tool.postExecute",
      { ...toolPre(), isError: false, content: "ok", durationMs: 1 },
      signal(),
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    const keys = await redis.keys("*hook-warn*");
    expect(keys.length).toBe(2);
    for (const k of keys) {
      const ttl = await redis.pttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    }
  });

  it("an observe hook past hooks.timeoutMs is aborted and warned about", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ timeoutMs: 30, log });
    let aborted = false;
    plugin("alpha").on(
      "tool.preExecute",
      (_p, s) =>
        new Promise<void>((resolve) => {
          s.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      { mode: "observe" },
    );
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(aborted).toBe(true);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "timed out after 30 ms" });
  });

  it("mutating the payload in an observe hook is ignored", async () => {
    const { r, plugin } = setup();
    plugin("alpha").on(
      "tool.preExecute",
      (p) => {
        (p.input as { x: number }).x = 2;
      },
      { mode: "observe" },
    );
    const original = toolPre({ x: 1 });
    expect(await r.run("tool.preExecute", original, signal())).toEqual({ allowed: true });
    expect(original.input).toEqual({ x: 1 });
  });

  it(`at most ${OBSERVE_INFLIGHT_MAX} observe calls per plugin are in flight; overflow is dropped with a warning`, async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ timeoutMs: 10_000, log });
    let started = 0;
    const releases: (() => void)[] = [];
    const alpha = plugin("alpha").on(
      "tool.preExecute",
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          releases.push(resolve);
        }),
      { mode: "observe" },
    );
    for (let i = 0; i < OBSERVE_INFLIGHT_MAX + 3; i++) {
      await r.run("tool.preExecute", toolPre(), signal());
    }
    await vi.waitFor(() => expect(started).toBe(OBSERVE_INFLIGHT_MAX));
    expect(alpha.inflight.size).toBe(OBSERVE_INFLIGHT_MAX);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0]?.[0])).toContain("dropped");
    for (const f of releases) f();
    await vi.waitFor(() => expect(alpha.inflight.size).toBe(0));
    // capacity is back
    await r.run("tool.preExecute", toolPre(), signal());
    await vi.waitFor(() => expect(started).toBe(OBSERVE_INFLIGHT_MAX + 1));
    for (const f of releases) f();
  });
});

describe("HookRegistry.run: failures before the hooks run (Ruling R10)", () => {
  const failingEnablement = async (): Promise<Set<string>> => {
    throw new Error("pg down");
  };

  it("enablement lookup throws with a policy hook on the mount: deny, generic reason", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ enabled: failingEnablement, log });
    plugin("zeta").on("tool.preExecute", () => {}, { mode: "policy" });
    plugin("alpha").on("tool.preExecute", () => {}, { mode: "observe" });
    const out = await r.run("tool.preExecute", toolPre(), signal());
    expect(out).toMatchObject({
      allowed: false,
      plugin: "zeta",
      reason: "The zeta policy check failed",
      cause: "hook_error",
      preflight: true,
    });
    // the audit text must not claim zeta caused the failure
    const detail = (out.allowed === false && out.detail) || "";
    expect(detail).toContain("before any plugin was called");
    expect(detail).toContain("named only as the first policy plugin");
    expect(detail).toContain("pg down");
    expect(JSON.stringify(warn.mock.calls)).toContain("pg down");
  });

  it("enablement lookup throws with only observe hooks: allow and warn", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ enabled: failingEnablement, log });
    const alpha = vi.fn();
    plugin("alpha").on("tool.preExecute", alpha, { mode: "observe" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(alpha).not.toHaveBeenCalled();
  });

  it("an uncloneable payload with a policy hook: deny; with only observe hooks: allow", async () => {
    const bad = toolPre({ fn: () => 1 });
    const policy = setup();
    policy.plugin("alpha").on("tool.preExecute", () => {}, { mode: "policy" });
    expect(await policy.r.run("tool.preExecute", bad, signal())).toMatchObject({
      allowed: false,
      cause: "hook_error",
      reason: "The alpha policy check failed",
    });
    const observe = setup();
    observe.plugin("alpha").on("tool.preExecute", () => {}, { mode: "observe" });
    expect(await observe.r.run("tool.preExecute", bad, signal())).toEqual({ allowed: true });
  });
});

describe("HookRegistry.run: the caller's abort", () => {
  it("an already aborted signal throws its reason", async () => {
    const { r, plugin } = setup();
    const hook = vi.fn();
    plugin("alpha").on("tool.preExecute", hook, { mode: "policy" });
    const ac = new AbortController();
    const reason = new Error("caller gave up");
    ac.abort(reason);
    await expect(r.run("tool.preExecute", toolPre(), ac.signal)).rejects.toBe(reason);
    expect(hook).not.toHaveBeenCalled();
  });

  it("an abort while a policy hook runs throws the reason, never a deny; later hooks don't run", async () => {
    const { r, plugin } = setup({ timeoutMs: 10_000 });
    const ac = new AbortController();
    const reason = new Error("caller gave up");
    plugin("alpha").on(
      "tool.preExecute",
      () => {
        queueMicrotask(() => ac.abort(reason));
        return new Promise<void>(() => {});
      },
      { mode: "policy" },
    );
    const zeta = vi.fn();
    plugin("zeta").on("tool.preExecute", zeta, { mode: "policy" });
    await expect(r.run("tool.preExecute", toolPre(), ac.signal)).rejects.toBe(reason);
    expect(zeta).not.toHaveBeenCalled();
  });
});

describe("HookRegistry: listeners and detail", () => {
  it("many runs on one signal leave no abort listeners behind", async () => {
    const { r, plugin } = setup();
    plugin("alpha").on("tool.preExecute", () => {}, { mode: "policy" });
    plugin("beta").on("tool.preExecute", () => ({ deny: "no" }), { mode: "policy" });
    const ac = new AbortController();
    const before = getEventListeners(ac.signal, "abort").length;
    for (let i = 0; i < 50; i++) await r.run("tool.preExecute", toolPre(), ac.signal);
    expect(getEventListeners(ac.signal, "abort").length).toBe(before);
  });

  it(`detail is clipped to ${HOOK_DETAIL_MAX_CHARS} characters`, async () => {
    const { r, plugin } = setup();
    plugin("alpha").on(
      "tool.preExecute",
      () => {
        throw new Error("e".repeat(10_000));
      },
      { mode: "policy" },
    );
    const out = await r.run("tool.preExecute", toolPre(), signal());
    expect(out.allowed === false && out.detail?.length).toBe(HOOK_DETAIL_MAX_CHARS);
  });
});

describe("HookRegistry.run: a policy plugin not loaded on this replica (M-1)", () => {
  it("fails closed: generic reason, notLoaded, a throttled warning naming the plugin; no hook runs", async () => {
    const { warn, log } = warnSpy();
    const { r, plugin } = setup({ expected: { beta: ["tool.preExecute"] }, log });
    const alpha = vi.fn();
    const observed = vi.fn();
    plugin("alpha").on("tool.preExecute", alpha, { mode: "policy" });
    plugin("zeta").on("tool.preExecute", observed, { mode: "observe" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toMatchObject({
      allowed: false,
      plugin: "beta",
      reason: "The beta policy check is unavailable",
      cause: "hook_error",
      notLoaded: true,
      detail: expect.stringContaining("not loaded on this replica"),
    });
    expect(alpha).not.toHaveBeenCalled();
    // observe hooks still see the denied call
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("policy extension not loaded"),
        expect.objectContaining({ plugin: "beta", mount: "tool.preExecute" }),
      ),
    );
    await r.run("tool.preExecute", toolPre(), signal());
    await new Promise((res) => setTimeout(res, 20));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("not loaded"))).toHaveLength(1);
  });

  it("has() is true with no local hooks; denies without any local instance", async () => {
    const { r } = setup({ expected: { beta: ["model.request"] } });
    expect(r.has("model.request")).toBe(true);
    expect(r.has("tool.preExecute")).toBe(false);
    expect(r.has("model.response")).toBe(false);
    expect(await r.run("model.request", modelReq(), signal())).toMatchObject({
      allowed: false,
      plugin: "beta",
      notLoaded: true,
    });
  });

  it("an organization that has not enabled the plugin is not affected", async () => {
    const { r } = setup({ expected: { beta: ["tool.preExecute"] }, enabled: ["alpha"] });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
  });

  it("once the plugin is loaded here its own hooks decide (no policy hook registered: allowed)", async () => {
    const { r, plugin } = setup({ expected: { beta: ["tool.preExecute"] } });
    plugin("beta").on("tool.preExecute", () => {}, { mode: "observe" });
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
  });
});

describe("HookRegistry: has / handlers", () => {
  it("no handlers: has() is false and run allows without querying the organization", async () => {
    const enabledPlugins = vi.fn(async () => new Set<string>());
    const { r } = setup({ enabled: enabledPlugins });
    expect(r.has("tool.preExecute")).toBe(false);
    expect(await r.run("tool.preExecute", toolPre(), signal())).toEqual({ allowed: true });
    expect(enabledPlugins).not.toHaveBeenCalled();
  });

  it("has() follows the active instances", () => {
    const { r, plugin, remove } = setup();
    const a = plugin("alpha").on("tool.preExecute", () => {}, { mode: "observe" });
    expect(r.has("tool.preExecute")).toBe(true);
    expect(r.has("model.request")).toBe(false);
    remove(a);
    expect(r.has("tool.preExecute")).toBe(false);
  });

  it("handlers('usage.report') lists handlers by plugin name, tracked as in-flight calls", async () => {
    const { r, plugin } = setup();
    let inflight = -1;
    const zeta = plugin("zeta");
    zeta.on(
      "usage.report",
      async () => {
        inflight = zeta.inflight.size;
      },
      { mode: "observe" },
    );
    plugin("alpha").on("usage.report", async () => {}, { mode: "observe" });
    const hs = r.handlers("usage.report");
    expect(hs.map((x) => x.plugin)).toEqual(["alpha", "zeta"]);
    await hs[1]?.handler({} as HookPayloads["usage.report"], signal());
    expect(inflight).toBe(1);
  });
});

describe("helpers", () => {
  it("sanitizeDenyReason: control characters, whitespace, clipping by code point, empty", () => {
    expect(sanitizeDenyReason("a\u0000b\r\nc\u009fd")).toBe("a b c d");
    expect(sanitizeDenyReason(" \n\t ")).toBe(EMPTY_DENY_REASON);
    expect(sanitizeDenyReason("")).toBe(EMPTY_DENY_REASON);
    const long = sanitizeDenyReason("x".repeat(1000));
    expect(long.length).toBe(HOOK_REASON_MAX_CHARS);
    // the clip point falls inside an astral character: it is dropped whole, never split
    const emoji = sanitizeDenyReason(`${"x".repeat(HOOK_REASON_MAX_CHARS - 2)}${"😀".repeat(10)}`);
    expect(emoji.length).toBeLessThanOrEqual(HOOK_REASON_MAX_CHARS);
    expect(emoji.endsWith("x…")).toBe(true);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("errMsg survives a throwing toString / message", () => {
    const evil = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(errMsg(evil)).toBe("unprintable error");
    const e = new Error("x");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error("nope");
      },
    });
    expect(errMsg(e)).toBe("unprintable error");
  });
});

const manifest = (): ExtensionManifest =>
  defineExtension({
    name: "hooky",
    version: "0.1.0",
    sdk: "^0.1.0",
    provides: [],
    permissions: {
      hooks: ["tool.preExecute", "model.request", "model.response", "session.start"],
      policyHooks: ["tool.preExecute"],
    },
    setup() {},
  });

describe("ctx.hooks.on", () => {
  it("keeps the hook on the ctx and in the ledger; closing the ctx revokes it", async () => {
    const ctx = createExtensionContext(deps, manifest(), undefined);
    ctx.hooks.on("tool.preExecute", () => {}, { mode: "policy" });
    ctx.sealTools();
    expect(ctx.ledger.list().map((x) => `${x.kind}:${x.key}`)).toEqual(["hook:tool.preExecute"]);
    expect(ctx.registeredHooks.map((h) => `${h.mount}/${h.mode}`)).toEqual([
      "tool.preExecute/policy",
    ]);
    await ctx.close();
    expect(ctx.registeredHooks).toEqual([]);
  });

  it("throws for the four illegal uses", async () => {
    const ctx = createExtensionContext(deps, manifest(), undefined);
    try {
      // not declared in permissions.hooks
      expect(() => ctx.hooks.on("tool.postExecute", () => {}, { mode: "observe" })).toThrow(
        ExtensionPermissionError,
      );
      // declared, but reserved (not in HOOKS_AVAILABLE)
      const reserved = () =>
        ctx.hooks.on("session.start" as "model.request", () => {}, { mode: "observe" });
      expect(reserved).toThrow(/not available/);
      expect(reserved).not.toThrow(ExtensionPermissionError);
      // policy on a mount point that cannot deny
      expect(() => ctx.hooks.on("model.response", () => {}, { mode: "policy" })).toThrow(/policy/);
      // policy on a mount point missing from permissions.policyHooks (M-1)
      expect(() => ctx.hooks.on("model.request", () => {}, { mode: "policy" })).toThrow(
        ExtensionPermissionError,
      );
      ctx.sealTools();
      // outside setup
      expect(() => ctx.hooks.on("tool.preExecute", () => {}, { mode: "observe" })).toThrow(
        /only allowed during setup/,
      );
      expect(ctx.registeredHooks).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe("plugin host", () => {
  const drainState = () => {
    const g = globalThis as { __hooksDrain?: HooksDrainState };
    g.__hooksDrain = { setups: 0, calls: [], gate: undefined };
    let release: () => void = () => {};
    g.__hooksDrain.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { s: g.__hooksDrain, release };
  };

  it("unload and reload revoke the instance's hooks through the ledger", async () => {
    const h = new ExtensionHost(deps, {}, { autoApprove: true });
    hosts.push(h);
    await h.load([fx("hooks-a")]);
    vi.spyOn(h, "enabledPlugins").mockResolvedValue(new Set(["hooks-a"]));
    expect(h.hooks.has("tool.preExecute")).toBe(true);
    expect(h.hooks.has("model.response")).toBe(true);
    const first = h.current("hooks-a");
    expect(first?.registrations().map((x) => `${x.kind}:${x.key}`)).toEqual([
      "hook:tool.preExecute",
      "hook:model.response",
    ]);

    await h.reload("hooks-a", { drainMs: 0 });
    expect(first?.hooks).toEqual([]);
    expect(await h.hooks.run("tool.preExecute", toolPre({ deny: true }), signal())).toEqual({
      allowed: false,
      plugin: "hooks-a",
      reason: "blocked by hooks-a",
      cause: "deny",
    });

    await h.unload("hooks-a", { drainMs: 0 });
    expect(h.hooks.has("model.response")).toBe(false);
    // M-1: deployment state still expects its policy hook (approved snapshot), so calls fail closed
    expect(h.expectedPolicy("tool.preExecute")).toEqual(["hooks-a"]);
    expect(h.hooks.has("tool.preExecute")).toBe(true);
    expect(await h.hooks.run("tool.preExecute", toolPre(), signal())).toMatchObject({
      allowed: false,
      plugin: "hooks-a",
      notLoaded: true,
    });
  });

  it("during an upgrade's drain window each hook fires exactly once, and the old call is drained", async () => {
    const { s, release } = drainState();
    const h = new ExtensionHost(deps, {}, { autoApprove: true });
    hosts.push(h);
    await h.load([fx("hooks-drain")]);
    vi.spyOn(h, "enabledPlugins").mockResolvedValue(new Set(["hooks-drain"]));
    const old = h.current("hooks-drain");
    // call A is held inside generation 1's policy hook
    const a = h.hooks.run("tool.preExecute", toolPre({ hold: 1 }), signal());
    await vi.waitFor(() => expect(s.calls).toEqual(["policy:1"]));
    const reloading = h.reload("hooks-drain", { drainMs: 10_000 });
    await vi.waitFor(() => expect(h.current("hooks-drain")).not.toBe(old));
    // call B during the drain window: only generation 2 fires
    expect(await h.hooks.run("tool.preExecute", toolPre(), signal())).toMatchObject({
      reason: "generation 2",
    });
    expect(old?.inflight.size).toBe(1);
    release();
    // A finishes on generation 1 (drained, not aborted); the reload then completes
    expect(await a).toMatchObject({ reason: "generation 1", cause: "deny" });
    await reloading;
    await vi.waitFor(() => expect(s.calls.filter((c) => c.startsWith("observe")).length).toBe(2));
    expect([...s.calls].sort()).toEqual(["observe:2", "observe:2", "policy:1", "policy:2"]);
  });

  it("a policy hook cut off at the end of the drain reruns on the new generation", async () => {
    const { s, release } = drainState();
    const h = new ExtensionHost(deps, {}, { autoApprove: true });
    hosts.push(h);
    await h.load([fx("hooks-drain")]);
    vi.spyOn(h, "enabledPlugins").mockResolvedValue(new Set(["hooks-drain"]));
    const a = h.hooks.run("tool.preExecute", toolPre({ hold: 1 }), signal());
    await vi.waitFor(() => expect(s.calls).toEqual(["policy:1"]));
    await h.reload("hooks-drain", { drainMs: 50 });
    expect(await a).toMatchObject({ reason: "generation 2", cause: "deny" });
    expect(s.calls.filter((c) => c.startsWith("policy"))).toEqual(["policy:1", "policy:2"]);
    release();
  });
});
