import { randomUUID } from "node:crypto";
import {
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
import { deviceReqKey, deviceResKey } from "../../src/devices/keys.js";
import { DeviceRelay } from "../../src/devices/relay.js";
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

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  bus = createBus(redis, sub, "kernel");
  const log = createLogger("error", { write: () => {} });
  relay = new DeviceRelay(redis, bus, new LockService(redis, log), {
    get: () => ({ environments: { device: { reconnectGraceSeconds: graceSeconds } } }),
  } as unknown as KernelConfigService);
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await rd?.stop();
});
beforeEach(() => {
  graceSeconds = 5;
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
    await new Promise((r) => setTimeout(r, 2000));
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

  it("grace exceeded queues a cancel and throws environment.offline", async () => {
    graceSeconds = 1;
    const h = holder();
    await h.connect();
    const t0 = Date.now();
    const call = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 500, signal: signal() }),
    );
    const req = await h.next();
    await h.disconnect();
    const e = await call;
    expect(isOffline(e)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    // the cancel waits on the list for the next connect
    const queued = await redis.lrange(deviceReqKey(h.environmentId), 0, -1);
    expect(queued.map((x) => JSON.parse(x))).toEqual([{ type: "cancel", id: req.id }]);
    await h.connect();
    expect(await h.next((f) => f.type === "cancel")).toEqual({ type: "cancel", id: req.id });
    await h.disconnect();
  }, 10_000);

  it("abort queues a cancel and rejects with the abort reason", async () => {
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

  it("fs_gone maps to FileSystemGoneError, gone to SandboxGoneError, policy to a ToolError", async () => {
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
    const plain = await rejection(relay.call(env, "readFile", { path: "/w", maxBytes: 1 }, opts()));
    expect(plain).toBeInstanceOf(Error);
    expect(isSandboxGoneError(plain) || plain instanceof ToolError).toBe(false);
    expect((plain as Error).message).toBe("readFile failed");
    await h.disconnect();
  });

  it("an invalid result is refused (parseOpResult)", async () => {
    const h = holder(() => ({ ok: true, result: { exitCode: "zero" } }));
    await h.connect();
    const e = await rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 5000, signal: signal() }),
    );
    expect((e as Error).message).toMatch(/invalid exec result/);
    await h.disconnect();
  });

  it("every key written has a TTL; a short request never shortens the list's TTL", async () => {
    graceSeconds = 5;
    const h = holder();
    await h.connect();
    // the holder stops draining but keeps the lease: requests stay on the list
    await h.disconnect();
    await redis.set(`capk:device-lease:${h.environmentId}`, "x", "PX", 60_000);
    const ac = new AbortController();
    const long = rejection(
      relay.call(h.environmentId, "exec", execArgs, { deadlineMs: 20_000, signal: ac.signal }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const listKey = deviceReqKey(h.environmentId);
    const first = await redis.pttl(listKey);
    expect(first).toBeGreaterThan(20_000);
    expect(first).toBeLessThanOrEqual(25_000);
    const short = rejection(
      relay.call(h.environmentId, "stat", { path: "/w" }, { deadlineMs: 100, signal: ac.signal }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(await redis.pttl(listKey)).toBeGreaterThan(20_000);
    ac.abort(new Error("done"));
    await Promise.all([long, short]);
    // the cancels went onto the list too, which still has a TTL
    expect(await redis.llen(listKey)).toBe(4);
    expect(await redis.pttl(listKey)).toBeGreaterThan(0);
    // the holder's result keys carry a TTL as well
    const req = JSON.parse((await redis.lindex(listKey, 0)) as string) as KernelReq;
    await h.respond(req.id, { ok: true, result: EXEC_RESULT }, { publish: false });
    expect(await redis.pttl(deviceResKey(req.id))).toBeGreaterThan(0);
    await redis.del(listKey, `capk:device-lease:${h.environmentId}`, deviceResKey(req.id));
  }, 10_000);
});
