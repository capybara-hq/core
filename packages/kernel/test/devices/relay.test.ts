import { randomUUID } from "node:crypto";
import {
  DeviceProtocolError,
  type ExtensionContext,
  isFileSystemGoneError,
  isSandboxGoneError,
  type KernelReq,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceResKey,
  deviceResTopic,
} from "../../src/devices/keys.js";
import {
  DeviceRelay,
  HOLDER_POLL_MS,
  LEASE_CHECK_TIMEOUT_MS,
  LIST_TTL_MARGIN_MS,
} from "../../src/devices/relay.js";
import type { DeviceTargetState, DeviceTargets } from "../../src/devices/targets.js";
import { ApiError } from "../../src/errors.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { TestHolder } from "./test-holder.js";

/**
 * The caller side of the device relay (environments spec §13.4): requests go through a Redis list
 * per environment, results come back under the request id; the caller waits within its own call
 * for the deadline plus the reconnect grace.
 */

let rd: TestContainer;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let bus: ExtensionContext["bus"];
let relay: DeviceRelay;
let graceSeconds = 5;
/** What the stubbed PG says about each environment (absent: active). */
const states = new Map<string, DeviceTargetState>();
const targets = {
  state: async (env: string) => states.get(env) ?? "active",
} as Pick<DeviceTargets, "state"> as DeviceTargets;
const log = createLogger("error", { write: () => {} });

const EXEC_RESULT = { exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, timedOut: false };
const LIMITS = { cpu: 1, memoryMb: 512, diskMb: 1024, egress: "none", allowHosts: [] };
const execArgs = {
  command: "echo hi",
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  tag: "t1",
  actor: { accountId: "a", conversationId: "c" },
  limits: LIMITS,
};
const signal = () => AbortSignal.timeout(30_000);
const isOffline = (e: unknown) => e instanceof ApiError && e.code === "environment.offline";
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A relay over `r` (the test's connection unless given). */
const relayOver = (r: Redis) =>
  new DeviceRelay(
    r,
    bus,
    new LockService(r, log),
    {
      get: () => ({ environments: { device: { reconnectGraceSeconds: graceSeconds } } }),
    } as unknown as KernelConfigService,
    log,
    targets,
  );

/**
 * A relay whose request push is followed, before the push returns, by `onPush` (a holder that
 * answers within the push itself): the caller's ordering around the push decides what it sees.
 */
const relayAnsweringInPush = (onPush: (req: KernelReq) => Promise<void>) => {
  const proxied = new Proxy(redis, {
    get(target, prop) {
      if (prop === "eval") {
        return async (...a: unknown[]) => {
          const out = await (target.eval as (...x: unknown[]) => Promise<unknown>)(...a);
          // the push script has 5 arguments (script, 1, key, frame, ttl); giving up has 6
          if (a.length === 5) {
            const f = JSON.parse(a[3] as string) as KernelReq;
            if (f.type === "req") await onPush(f);
          }
          return out;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return relayOver(proxied);
};

/** Holds the lease without draining: requests stay queued (a machine that has not taken them). */
const holdLeaseOnly = (env: string) => redis.set(deviceLeaseKey(env), "x", "PX", 60_000);

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  bus = createBus(redis, sub, "kernel");
  relay = relayOver(redis);
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await rd?.stop();
});
beforeEach(() => {
  graceSeconds = 5;
  states.clear();
});

const holder = (answer?: (req: KernelReq) => Parameters<TestHolder["respond"]>[1] | undefined) =>
  new TestHolder(redis, bus, randomUUID(), answer);

describe("DeviceRelay", () => {
  it("offline when no holder: environment.offline at once, nothing queued", async () => {
    const env = randomUUID();
    const t0 = Date.now();
    const e = await rejection(
      relay.call(env, "exec", execArgs, { deadlineMs: 5000, signal: signal() }),
    );
    expect(isOffline(e)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
    expect(await relay.holderLive(env)).toBe(false);
  });

  it("exec round-trip returns the ExecResult", async () => {
    const h = holder(() => ({ ok: true, result: EXEC_RESULT }));
    await h.connect();
    expect(await relay.holderLive(h.environmentId)).toBe(true);
    const r = await relay.call(h.environmentId, "exec", execArgs, {
      deadlineMs: 6000,
      signal: signal(),
    });
    expect(r).toEqual(EXEC_RESULT);
    const req = h.frames[0] as KernelReq;
    expect(req).toMatchObject({ type: "req", op: "exec", args: execArgs, deadlineMs: 6000 });
    // the result key is consumed
    expect(await redis.exists(deviceResKey(req.id))).toBe(0);
    await h.disconnect();
  });

  it("a result stored before the publish could reach anyone is found by the read after pushing", async () => {
    const env = randomUUID();
    await holdLeaseOnly(env);
    const r = relayAnsweringInPush(async (req) => {
      await redis.set(
        deviceResKey(req.id),
        JSON.stringify({ type: "res", id: req.id, ok: true, result: EXEC_RESULT }),
        "PX",
        60_000,
      );
    });
    const t0 = Date.now();
    expect(await r.call(env, "exec", execArgs, { deadlineMs: 20_000, signal: signal() })).toEqual(
      EXEC_RESULT,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    await redis.del(deviceLeaseKey(env), deviceReqKey(env));
  });

  it("a result published as soon as the request is queued reaches the caller (it subscribed first)", async () => {
    const env = randomUUID();
    await holdLeaseOnly(env);
    const r = relayAnsweringInPush(async (req) => {
      await bus.publish(deviceResTopic(req.id), {
        type: "res",
        id: req.id,
        ok: true,
        result: EXEC_RESULT,
      });
    });
    const call = r.call(env, "exec", execArgs, { deadlineMs: 20_000, signal: signal() });
    const late = sleep(2000).then(() => "too late");
    expect(await Promise.race([call, late])).toEqual(EXEC_RESULT);
    await redis.del(deviceLeaseKey(env), deviceReqKey(env));
  });

  it("result produced during a disconnect is delivered after reconnect", async () => {
    graceSeconds = 5;
    const h = holder();
    await h.connect();
    const call = relay.call(h.environmentId, "exec", execArgs, {
      deadlineMs: 1000,
      signal: signal(),
    });
    const req = await h.next();
    await h.disconnect();
    await sleep(2000);
    await h.connect();
    await h.respond(req.id, { ok: true, result: EXEC_RESULT });
    expect(await call).toEqual(EXEC_RESULT);
    await h.disconnect();
  }, 15_000);

  it("a stored result whose publish was lost is still found before giving up", async () => {
    graceSeconds = 1;
    const h = holder();
    await h.connect();
    const call = relay.call(h.environmentId, "exec", execArgs, {
      deadlineMs: 500,
      signal: signal(),
    });
    const req = await h.next();
    await h.respond(req.id, { ok: true, result: EXEC_RESULT }, { publish: false });
    expect(await call).toEqual(EXEC_RESULT);
    await h.disconnect();
  }, 10_000);

  it("grace exceeded on a taken request queues a cancel and throws environment.offline", async () => {
    graceSeconds = 1;
    const h = holder();
    await h.connect();
    const t0 = Date.now();
    const call = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 500, signal: signal() }),
    );
    const req = await h.next();
    // the lease stays (a holder that took the request and never answers)
    await h.disconnect();
    await holdLeaseOnly(h.environmentId);
    const e = await call;
    expect(isOffline(e)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    // the cancel waits on the list for the next connect, under a TTL
    const listKey = deviceReqKey(h.environmentId);
    const queued = await redis.lrange(listKey, 0, -1);
    expect(queued.map((x) => JSON.parse(x))).toEqual([{ type: "cancel", id: req.id }]);
    expect(await redis.pttl(listKey)).toBeGreaterThan(0);
    await h.connect();
    expect(await h.next((f) => f.type === "cancel")).toEqual({ type: "cancel", id: req.id });
    await h.disconnect();
  }, 10_000);

  it("a request given up on before the machine took it is removed: nothing reaches the machine", async () => {
    graceSeconds = 1;
    const env = randomUUID();
    await holdLeaseOnly(env);
    const e = await rejection(
      relay.call(env, "exec", execArgs, { deadlineMs: 500, signal: signal() }),
    );
    expect(isOffline(e)).toBe(true);
    const ac = new AbortController();
    const aborted = rejection(
      relay.call(env, "stat", { path: "/w" }, { deadlineMs: 5000, signal: ac.signal }),
    );
    await sleep(100);
    ac.abort(new Error("stop"));
    expect(((await aborted) as Error).message).toBe("stop");
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
    const h = new TestHolder(redis, bus, env);
    await h.connect();
    await sleep(200);
    expect(h.frames).toEqual([]);
    await h.disconnect();
  }, 10_000);

  it("a holder lost mid-call ends the wait one grace after the loss, not at the deadline", async () => {
    graceSeconds = 1;
    const h = holder();
    await h.connect();
    const t0 = Date.now();
    const call = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 30_000, signal: signal() }),
    );
    const req = await h.next();
    await h.disconnect();
    const e = await call;
    expect(isOffline(e)).toBe(true);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1000);
    expect(took).toBeLessThan(HOLDER_POLL_MS + 1000 + 2000);
    const queued = await redis.lrange(deviceReqKey(h.environmentId), 0, -1);
    expect(queued.map((x) => JSON.parse(x))).toEqual([{ type: "cancel", id: req.id }]);
    await redis.del(deviceReqKey(h.environmentId));
  }, 15_000);

  it.each([
    ["revoked", "environment.forbidden"],
    ["deleted", "environment.not_found"],
  ] as const)(
    "a machine %s while a call waits fails it at the next lease check with %s (ruling R27)",
    async (state, code) => {
      graceSeconds = 60;
      const h = holder();
      await h.connect();
      const t0 = Date.now();
      const call = rejection(
        relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 30_000, signal: signal() }),
      );
      await h.next();
      states.set(h.environmentId, state);
      await h.disconnect();
      const e = await call;
      expect(e instanceof ApiError && e.code === code).toBe(true);
      // within one poll, far from the 90 s the deadline plus the grace would take
      expect(Date.now() - t0).toBeLessThan(HOLDER_POLL_MS + 2000);
      // a new call is refused the same way at once, not as offline
      const again = await rejection(
        relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 1000, signal: signal() }),
      );
      expect(again instanceof ApiError && again.code === code).toBe(true);
      await redis.del(deviceReqKey(h.environmentId));
    },
    15_000,
  );

  it("a reconnect within the grace restores the full wait: a long command still delivers", async () => {
    graceSeconds = 3;
    const h = holder();
    await h.connect();
    const t0 = Date.now();
    const call = relay.call(h.environmentId, "exec", execArgs, {
      deadlineMs: 15_000,
      signal: signal(),
    });
    const req = await h.next();
    const at = (ms: number) => sleep(Math.max(0, ms - (Date.now() - t0)));
    // the lease is gone across the first lease check (~5 s), which caps the wait at ~8 s, and back
    // well before the capped time; each step leaves 1.5 s or more of slack
    await at(HOLDER_POLL_MS - 1500);
    await h.disconnect();
    await at(HOLDER_POLL_MS + 1500);
    await h.connect();
    // answered well after the capped give-up time, well before the full one (~18 s)
    await at(HOLDER_POLL_MS + 3000 + 2500);
    await h.respond(req.id, { ok: true, result: EXEC_RESULT });
    expect(await call).toEqual(EXEC_RESULT);
    await h.disconnect();
  }, 30_000);

  it("a stalled lease check does not hold the give-up back", async () => {
    graceSeconds = 1;
    const env = randomUUID();
    await holdLeaseOnly(env);
    let stall = false;
    const stalling = new DeviceRelay(
      redis,
      bus,
      {
        holderOf: (key: string) => (stall ? new Promise<string | null>(() => {}) : redis.get(key)),
      } as unknown as LockService,
      {
        get: () => ({ environments: { device: { reconnectGraceSeconds: graceSeconds } } }),
      } as unknown as KernelConfigService,
      log,
      targets,
    );
    const t0 = Date.now();
    const call = rejection(
      stalling.call(env, "exec", execArgs, { deadlineMs: 500, signal: signal() }),
    );
    await sleep(100);
    stall = true;
    expect(isOffline(await call)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500 + LEASE_CHECK_TIMEOUT_MS + 1000);
    await redis.del(deviceLeaseKey(env), deviceReqKey(env));
  }, 10_000);

  it("abort of a taken request queues a cancel and rejects with the abort reason", async () => {
    const h = holder();
    await h.connect();
    const ac = new AbortController();
    const call = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 5000, signal: ac.signal }),
    );
    const req = await h.next();
    const reason = new Error("stopped");
    ac.abort(reason);
    expect(await call).toBe(reason);
    expect(await h.next((f) => f.type === "cancel")).toEqual({ type: "cancel", id: req.id });
    await h.disconnect();
  });

  it("an already aborted signal rejects without queueing", async () => {
    const h = holder();
    await h.connect();
    const ac = new AbortController();
    ac.abort(new Error("early"));
    const e = await rejection(
      relay.call(h.environmentId, "stat", { path: "/x" }, { deadlineMs: 5000, signal: ac.signal }),
    );
    expect((e as Error).message).toBe("early");
    expect(await redis.exists(deviceReqKey(h.environmentId))).toBe(0);
    expect(h.frames).toEqual([]);
    await h.disconnect();
  });

  it("fs_gone maps to FileSystemGoneError, gone to SandboxGoneError, policy and error to ToolErrors", async () => {
    const kinds = {
      create: "fs_gone",
      stat: "gone",
      writeFile: "policy",
      readFile: "error",
    } as const;
    const h = holder((req) => ({
      ok: false,
      error: { kind: kinds[req.op as keyof typeof kinds], message: `${req.op} failed` },
    }));
    await h.connect();
    const opts = () => ({ deadlineMs: 5000, signal: signal() });
    const env = h.environmentId;
    const fsGone = await rejection(relay.call(env, "create", { limits: LIMITS }, opts()));
    expect(isFileSystemGoneError(fsGone)).toBe(true);
    const gone = await rejection(relay.call(env, "stat", { path: "/w" }, opts()));
    expect(isSandboxGoneError(gone)).toBe(true);
    const policy = await rejection(
      relay.call(env, "writeFile", { path: "/w", dataB64: "" }, opts()),
    );
    expect(policy).toBeInstanceOf(ToolError);
    expect((policy as Error).message).toBe(
      "Refused by the machine's local policy: writeFile failed",
    );
    // ruling R28: the machine's own failure reaches the model as it said it
    const plain = await rejection(relay.call(env, "readFile", { path: "/w", maxBytes: 1 }, opts()));
    expect(plain).toBeInstanceOf(ToolError);
    expect((plain as Error).message).toBe("On the connected machine: readFile failed");
    await h.disconnect();
  });

  it("an invalid result is refused (parseOpResult)", async () => {
    const h = holder(() => ({ ok: true, result: { exitCode: "zero" } }));
    await h.connect();
    const e = await rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 5000, signal: signal() }),
    );
    expect(e).toBeInstanceOf(DeviceProtocolError);
    expect((e as Error).message).toMatch(/invalid exec result/);
    await h.disconnect();
  });

  it("a malformed result frame: the key is deleted, the request cancelled, a protocol error thrown", async () => {
    const h = holder();
    await h.connect();
    const call = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 5000, signal: signal() }),
    );
    const req = await h.next();
    await redis.set(deviceResKey(req.id), '{"type":"res","ok":"maybe"}', "PX", 60_000);
    await bus.publish(deviceResTopic(req.id), { type: "res", id: req.id, ok: "maybe" });
    const e = await call;
    expect(e).toBeInstanceOf(DeviceProtocolError);
    expect(await redis.exists(deviceResKey(req.id))).toBe(0);
    expect(await h.next((f) => f.type === "cancel")).toEqual({ type: "cancel", id: req.id });
    await h.disconnect();
  });

  it("a failing cancel push does not replace the outcome", async () => {
    const h = holder();
    await h.connect();
    let failGiveUp = true;
    const proxied = new Proxy(redis, {
      get(target, prop) {
        if (prop === "eval") {
          return async (...a: unknown[]) => {
            if (a.length === 6 && failGiveUp) throw new Error("redis down");
            return (target.eval as (...x: unknown[]) => Promise<unknown>)(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = relayOver(proxied);
    const ac = new AbortController();
    const call = rejection(
      r.call(h.environmentId, "exec", execArgs, { deadlineMs: 5000, signal: ac.signal }),
    );
    await h.next();
    const reason = new Error("aborted by the run");
    ac.abort(reason);
    expect(await call).toBe(reason);
    failGiveUp = false;
    await h.disconnect();
  });

  it("the request list always has a TTL; a short request never shortens it", async () => {
    graceSeconds = 5;
    const env = randomUUID();
    await holdLeaseOnly(env);
    const ac = new AbortController();
    const long = rejection(
      relay.call(env, "exec", execArgs, { deadlineMs: 20_000, signal: ac.signal }),
    );
    await sleep(200);
    const listKey = deviceReqKey(env);
    const first = await redis.pttl(listKey);
    expect(first).toBeGreaterThan(20_000 + 5000);
    expect(first).toBeLessThanOrEqual(20_000 + 5000 + LIST_TTL_MARGIN_MS);
    const short = rejection(
      relay.call(env, "stat", { path: "/w" }, { deadlineMs: 100, signal: ac.signal }),
    );
    await sleep(200);
    expect(await redis.llen(listKey)).toBe(2);
    expect(await redis.pttl(listKey)).toBeGreaterThan(20_000 + 5000);
    ac.abort(new Error("done"));
    await Promise.all([long, short]);
    // neither request was taken: both were removed, no cancel queued
    expect(await redis.exists(listKey)).toBe(0);
    await redis.del(deviceLeaseKey(env));
  }, 10_000);
});
