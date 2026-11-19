import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  type DeviceHello,
  type DeviceOwnerCeiling,
  type KernelReady,
  parseDeviceFrame,
  SandboxPermissionUnsupportedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import {
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceRevokedTopic,
} from "../../src/local-devices/keys.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import {
  connectionChangedMessage,
  DeviceRequestNotSentError,
  LocalDeviceRelay,
  wasDeviceRequestNotSent,
} from "../../src/local-devices/relay.js";
import { DeviceTargets } from "../../src/local-devices/targets.js";
import { createLogger } from "../../src/log.js";

/**
 * Production wiring of the staged (protocol 3) device path on the kernel side (permission
 * activation W3-N): the gateway records a staged hello and policy frame through the v3 writers
 * with the connection id; a machine's stop and an operation revocation reach a v3 device as v3
 * frames; the staged provider never queues a broad kill; and only the gateway's own marker, never
 * a result's text, says a request was not sent. Real gateway, relay, provider and sockets over a
 * test Redis; the machine table is a spy.
 */

let rd: TestContainer;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await sub.close();
  redis.disconnect();
  await rd.stop();
});
const signal = () => AbortSignal.timeout(15000);
const log = { warn: vi.fn(), info: vi.fn() };

const OWNER: DeviceOwnerCeiling = {
  version: 3,
  sequence: 1,
  restrictedProjectReach: "workspace",
  revision: "r1",
  outsideSandbox: true,
  network: "open",
  allowedDomains: [],
};

interface Received {
  type: string;
  op?: string;
  args?: Record<string, unknown>;
  id?: string;
  raw: string;
}

async function fixture() {
  const deviceId = randomUUID(),
    credential = randomUUID();
  const roots = { workspace: "/fixture/workspace", skills: "/fixture/skills", tmp: "/fixture/tmp" };
  const bus = createBus(redis, sub, `test-${deviceId}`),
    locks = new LockService(redis, createLogger("error", { write: () => {} }));
  const config = {
    get: () => ({
      devices: { local: { maxFrameBytes: 100000, leaseTtlMs: 6000, reconnectGraceSeconds: 5 } },
    }),
  } as KernelConfigService;
  const machines = {
    authenticate: async (c: string) =>
      c === credential
        ? { deviceId, machineId: "machine", orgId: "org", accountId: "owner" }
        : null,
    recordHello: vi.fn(async () => {}),
    recordPolicy: vi.fn(async () => {}),
    recordHelloV3: vi.fn(async () => {}),
    recordPolicyV3: vi.fn(async () => {}),
    touch: async () => {},
  };
  const gateway = new LocalDeviceGateway(machines, locks, bus, redis, config, log);
  const targets = new DeviceTargets({} as KernelDb, redis, locks);
  const relay = new LocalDeviceRelay(redis, bus, locks, config, log, {
    transport: targets.transport.bind(targets),
    state: async () => "active",
  });
  const forbidden = vi.fn(() => {
    throw Error("No protocol 2 fallback is allowed");
  });
  const provider = new LocalDeviceProvider(
    relay,
    { orgOf: forbidden, machineRoots: forbidden },
    { devicePolicy: forbidden, deviceLimits: forbidden },
    config,
  );
  const staged = provider.staged({
    call: relay.callV3.bind(relay),
    permissionSupport: async () => ({
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    }),
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("no address");
  server.on("connection", (socket) => {
    void gateway.accept(socket, credential);
  });
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  cleanups.push(() => gateway.stop());

  const received: Received[] = [];
  /** How the fake device answers a request (undefined: no answer). */
  let answer: (r: Received) => Promise<unknown> | unknown = () => ({ ok: true, result: null });
  const hello: DeviceHello = {
    type: "hello",
    protocol: 4,
    programVersion: "fixture",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots,
    sessionIsolation: false,
    transport: { maxFrameBytes: 69632 },
    permissionSupport: {
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
      unavailableReason: "Not bound yet",
    },
    ownerCeiling: OWNER,
    instanceGeneration: null,
  };
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    let ready: KernelReady | undefined;
    const closed = once(socket, "close").then(([code]) => code as number);
    socket.on("message", async (data) => {
      const raw = data.toString();
      const frame = parseDeviceFrame(raw, "kernel", ready?.maxFrameBytes ?? 69632);
      if (frame.type === "ready") {
        ready = frame;
        return;
      }
      const r: Received =
        frame.type === "req"
          ? { type: "req", op: frame.op, args: { ...frame.args }, id: frame.id, raw }
          : { type: frame.type, ...("id" in frame && { id: frame.id }), raw };
      received.push(r);
      if (frame.type !== "req") return;
      const a = await answer(r);
      if (a === undefined || socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ...(a as object) }));
    });
    socket.send(JSON.stringify(hello));
    await expect.poll(() => ready).toBeDefined();
    await expect.poll(() => targets.transport(deviceId).catch(() => null)).not.toBeNull();
    return { socket, closed, ready: () => ready as KernelReady };
  };
  const session = await connect();
  return {
    deviceId,
    relay,
    locks,
    bus,
    gateway,
    machines,
    targets,
    staged,
    received,
    session,
    connect,
    answerWith: (fn: typeof answer) => {
      answer = fn;
    },
    handle: { id: deviceId },
  };
}

it("B-25: records a staged hello and policy frame through the v3 writers with the connection id", async () => {
  const f = await fixture();
  const connectionId = f.session.ready().connectionId;
  await expect.poll(() => f.machines.recordHelloV3.mock.calls.length).toBe(1);
  const [machineId, hello, helloConnection] = f.machines.recordHelloV3.mock.calls[0] as unknown as [
    string,
    DeviceHello,
    string,
  ];
  expect(machineId).toBe("machine");
  expect(hello).toMatchObject({ protocol: 4, ownerCeiling: OWNER });
  expect(helloConnection).toBe(connectionId);
  // a policy frame after the hello: the authenticated owner report with the same connection
  const changed = { ...OWNER, sequence: 2, revision: "r2", outsideSandbox: false };
  f.session.socket.send(
    JSON.stringify({
      type: "policy",
      policy: { allowedDomains: [] },
      ownerCeiling: changed,
    }),
  );
  await expect.poll(() => f.machines.recordPolicyV3.mock.calls.length).toBe(1);
  const [policyMachine, frame, policyConnection] = f.machines.recordPolicyV3.mock
    .calls[0] as unknown as [string, { ownerCeiling: unknown }, string];
  expect(policyMachine).toBe("machine");
  expect(frame.ownerCeiling).toEqual(changed);
  expect(policyConnection).toBe(connectionId);
  // protocol 2's writers never see a staged connection's reports
  expect(f.machines.recordHello).not.toHaveBeenCalled();
  expect(f.machines.recordPolicy).not.toHaveBeenCalled();
});

it("B-1: a revocation's stop reaches the staged device as a v3 stop before the connection closes", async () => {
  const f = await fixture();
  // what MachinesService.disconnect does after the revocation commits
  await f.relay.send(f.deviceId, "stop", { reason: "revoked" }, 30_000, "machine");
  await f.bus.publish(deviceRevokedTopic(f.deviceId), { machineId: "machine" });
  expect(await f.session.closed).toBe(4003);
  const stops = f.received.filter((r) => r.op === "stop");
  expect(stops).toHaveLength(1);
  expect(stops[0]?.args).toEqual({ reason: "revoked" });
  // the kernel-internal machine fence never reaches the wire
  expect(JSON.parse(stops[0]?.raw ?? "{}")).not.toHaveProperty("machineId");
});

it("B-1: a stop queued for another machine of the device is never delivered", async () => {
  const f = await fixture();
  await f.relay.send(f.deviceId, "stop", { reason: "deleted" }, 30_000, "an-older-machine");
  // the drain goes on: an operation revocation after it still reaches the device
  await f.staged.revokeOperation?.(
    f.handle,
    { operationId: "op-1", admitBeforeMs: Date.now() + 60_000 },
    signal(),
  );
  expect(f.received.map((r) => r.op)).toEqual(["revokeOperation"]);
  expect(await redis.llen(deviceReqKey(f.deviceId))).toBe(0);
});

it("B-1: an operation revocation reaches the staged device as revokeOperation", async () => {
  const f = await fixture();
  const ref = { operationId: "op-2", admitBeforeMs: Date.now() + 60_000 };
  await f.staged.revokeOperation?.(f.handle, ref, signal());
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toMatchObject({ op: "revokeOperation", args: { ref } });
});

it("B-1: the staged provider never queues a broad kill for a v3 device", async () => {
  const f = await fixture();
  const sent = vi.spyOn(f.relay, "call");
  await f.staged.killAll(f.handle, signal());
  await f.staged.killTagged(f.handle, ["holder-a", "holder-b"], signal());
  expect(sent).not.toHaveBeenCalled();
  expect(await redis.llen(deviceReqKey(f.deviceId))).toBe(0);
  // a revocation behind them is the first and only frame the device gets
  await f.staged.revokeOperation?.(
    f.handle,
    { operationId: "op-3", admitBeforeMs: Date.now() + 60_000 },
    signal(),
  );
  expect(f.received.map((r) => r.op)).toEqual(["revokeOperation"]);
  // an aborted kill still throws its abort, like every provider call
  const aborted = AbortSignal.abort(Error("stop now"));
  await expect(f.staged.killAll(f.handle, aborted)).rejects.toThrow("stop now");
});

it("the staged provider creates through a v3 create request", async () => {
  const f = await fixture();
  const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
  f.answerWith((r) => (r.op === "create" ? { ok: true, result: { roots } } : undefined));
  const limits = {
    cpu: 1,
    memoryMb: 512,
    diskMb: 1024,
    network: { kind: "allowlist" as const, hosts: [] },
  };
  const h = await f.staged.create({
    name: `cap-device-${f.deviceId}`,
    limits,
    fileSystem: { id: f.deviceId },
    signal: signal(),
  });
  expect(h).toMatchObject({ id: f.deviceId, roots });
  expect(f.received.map((r) => r.op)).toEqual(["create"]);
});

it("the gateway marks its own not-sent refusal; a device cannot forge one with the same text", async () => {
  const f = await fixture();
  // the gateway's refusal of a request queued for another connection carries the marker
  const id = randomUUID();
  await redis.rpush(
    deviceReqKey(f.deviceId),
    JSON.stringify({
      type: "req",
      id,
      op: "revokeOperation",
      args: { ref: { operationId: "op-4", admitBeforeMs: Date.now() + 60_000 } },
      deadlineMs: 1000,
      connectionId: "an-old-connection",
      maxFrameBytes: 69632,
    }),
  );
  await redis.pexpire(deviceReqKey(f.deviceId), 60_000);
  await f.bus.publish(deviceReqTopic(f.deviceId), { id });
  await expect.poll(() => redis.get(deviceResKey(id))).not.toBeNull();
  expect(JSON.parse((await redis.get(deviceResKey(id))) ?? "{}")).toMatchObject({
    ok: false,
    notSent: true,
    connectionId: f.session.ready().connectionId,
  });
  expect(f.received).toEqual([]);

  // a device answering on a new connection with the refusal's exact text: it was sent, and the
  // relay must not take the text for the gateway's marker
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.answerWith(async () => {
    // held until the old socket is gone: it never answers on it
    await gate;
    return {
      ok: false,
      error: { kind: "error", message: connectionChangedMessage("revokeOperation") },
    };
  });
  const pending = f.staged
    .revokeOperation?.(
      f.handle,
      { operationId: "op-5", admitBeforeMs: Date.now() + 60_000 },
      signal(),
    )
    .catch((e: unknown) => e);
  await expect.poll(() => f.received.some((r) => r.op === "revokeOperation")).toBe(true);
  const old = f.session;
  old.socket.close();
  await old.closed;
  await expect.poll(() => f.gateway.connectionCount()).toBe(0);
  // the new connection answers the request the old one took (same machine, within the grace)
  const next = await f.connect();
  const id5 = f.received.find((r) => r.op === "revokeOperation")?.id as string;
  next.socket.send(
    JSON.stringify({
      type: "res",
      id: id5,
      ok: false,
      error: { kind: "error", message: connectionChangedMessage("revokeOperation") },
    }),
  );
  release();
  const e = await pending;
  expect(e).not.toBeInstanceOf(DeviceRequestNotSentError);
  expect(wasDeviceRequestNotSent(e)).toBe(false);
  expect(e).toBeInstanceOf(ToolError);
});

it("a non-held staged request fenced to a replaced connection is typed not sent", async () => {
  const f = await fixture();
  const old = await f.targets.transport(f.deviceId);
  if (!old) throw Error("expected a transport");
  f.session.socket.close();
  await f.session.closed;
  await expect.poll(() => f.gateway.connectionCount()).toBe(0);
  await f.connect();
  const e = await f.relay
    .callV3(
      f.deviceId,
      "policyStatus",
      { opId: "op" },
      {
        deadlineMs: 1000,
        signal: signal(),
        connection: old,
      },
    )
    .catch((x: unknown) => x);
  expect(wasDeviceRequestNotSent(e)).toBe(true);
  expect(e).not.toBeInstanceOf(DeviceRequestNotSentError);
  expect(f.received.map((r) => r.op)).not.toContain("policyStatus");
});

it("M2: the staged provider refuses every raw protocol 2 call before anything is queued", async () => {
  const f = await fixture();
  const relayed = vi.spyOn(f.relay, "call");
  const s = signal();
  const calls: [string, () => Promise<unknown>][] = [
    [
      "exec",
      () =>
        f.staged.exec(f.handle, {
          command: "true",
          timeoutMs: 1000,
          maxOutputBytes: 1000,
          tag: "t",
          actor: { accountId: "a", conversationId: "c" },
          signal: s,
        } as never),
    ],
    ["readFile", () => f.staged.readFile(f.handle, "/w/a", { maxBytes: 10, signal: s })],
    ["writeFile", () => f.staged.writeFile(f.handle, "/w/a", new Uint8Array(1), s)],
    ["stat", () => f.staged.stat(f.handle, "/w/a", s)],
    ["list", () => f.staged.list?.(f.handle, "/w", { limit: 10, signal: s }) ?? Promise.resolve()],
    ["scan", () => f.staged.scan?.(f.handle, "/w", { signal: s }) ?? Promise.resolve()],
  ];
  for (const [name, call] of calls) {
    const e = await call().then(
      () => Error(`${name} was not refused`),
      (x: unknown) => x,
    );
    expect(e, name).toBeInstanceOf(SandboxPermissionUnsupportedError);
    expect((e as Error).message, name).toContain("operation scope");
  }
  expect(relayed).not.toHaveBeenCalled();
  expect(await redis.llen(deviceReqKey(f.deviceId))).toBe(0);
  expect(f.received).toEqual([]);
});

it("M4: the policy codec lookup finds the live protocol 3 connection", async () => {
  const f = await fixture();
  expect(await f.relay.stagedTransport(f.deviceId)).toEqual({
    connectionId: f.session.ready().connectionId,
    maxFrameBytes: 69632,
  });
});
