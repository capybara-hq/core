import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { KernelReq } from "@capybara-hq/plugin-sdk/device-protocol";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { DialInGateway } from "../../src/dial-in/gateway.js";
import { DialInRelay } from "../../src/dial-in/relay.js";
import { DeviceTargets } from "../../src/dial-in/targets.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { localCall } from "../../src/local-devices/local-codec.js";
import { createLogger } from "../../src/log.js";
import { FakeMachineV3, HELLO_V3, helloEnvelope, localHandlers } from "./fake-machine-v3.js";

/**
 * The staged fake machine (permission activation B-28) against the real gateway's `accept`:
 * its hello is recorded through the v3 writers, the kernel's `ready` carries the connection id,
 * a `bindInstance` is answered with installed evidence, and a scripted answer reaches the relay.
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
const log = { warn: vi.fn(), info: vi.fn() };

async function fixture() {
  const deviceId = randomUUID(),
    credential = randomUUID();
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
    recordConnect: vi.fn(async () => {}),
    touch: async () => {},
    isDeviceDeleted: async () => false,
  };
  const handler = {
    kernelInternal: true as const,
    onHello: vi.fn(async () => ({ ok: true as const })),
    onFrame: vi.fn(async () => {}),
  };
  const gateway = new DialInGateway(
    machines,
    localHandlers(handler),
    locks,
    bus,
    redis,
    config,
    log,
  );
  const targets = new DeviceTargets({} as KernelDb, redis, locks);
  const relay = new DialInRelay(redis, bus, locks, config, log, {
    current: targets.current.bind(targets),
    state: async () => "active",
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("no address");
  server.on("connection", (socket) => {
    void gateway.accept(socket, credential, DEVICE_DIAL_IN_PROTOCOL);
  });
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  cleanups.push(() => gateway.stop());
  const url = `ws://127.0.0.1:${address.port}`;
  return { deviceId, credential, url, machines, handler, relay, targets };
}

const signal = () => AbortSignal.timeout(15000);

it("a fake machine's hello body reaches the handler with the connection id of its ready frame", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential);
  cleanups.push(async () => machine.close());
  const ready = await machine.ready;
  expect(f.handler.onHello).toHaveBeenCalledTimes(1);
  const [deviceId, hello, , connection] = f.handler.onHello.mock.calls[0] as unknown as [
    string,
    typeof HELLO_V3,
    AbortSignal,
    { machineId: string; connectionId: string },
  ];
  expect(deviceId).toBe(f.deviceId);
  expect(hello).toEqual(HELLO_V3);
  expect(connection).toEqual({ machineId: "machine", connectionId: ready.connectionId });
  // the envelope's program facts are recorded apart from the body
  expect(f.machines.recordConnect).toHaveBeenCalledWith("machine", {
    version: "0.1.0",
    os: "linux",
    arch: "x64",
  });
});

it("hello overrides carry body fields (features, policy)", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential, undefined, { hello: false });
  cleanups.push(async () => machine.close());
  await machine.opened;
  machine.hello({ features: ["projects"], policy: { allowedDomains: ["a.test"] } });
  await machine.ready;
  expect((f.handler.onHello.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
    features: ["projects"],
    policy: { allowedDomains: ["a.test"] },
  });
});

it("answers a bindInstance with evidence the relay validates against the request", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential);
  cleanups.push(async () => machine.close());
  await machine.ready;
  await expect.poll(() => f.targets.transport(f.deviceId).catch(() => null)).not.toBeNull();
  const args = {
    instanceId: randomUUID(),
    instanceGeneration: "1700000000000",
    bindingId: randomUUID(),
    expectedPreviousGeneration: null,
  };
  const result = await localCall(f.relay)(f.deviceId, "bindInstance", args, {
    deadlineMs: 6000,
    signal: signal(),
  });
  const sent = (await machine.next(
    (r) => r.type === "req" && String(r.op) === "bindInstance",
  )) as KernelReq;
  expect(sent.args).toEqual(args);
  expect(result).toMatchObject({
    instanceGeneration: "1700000000000",
    bindingId: args.bindingId,
    permissionSupport: { outsideSandbox: true, background: true },
  });
});

it("a catch-all null answer still binds; with autoBind false the scripted null reaches the relay", async () => {
  const bindArgs = () => ({
    instanceId: randomUUID(),
    instanceGeneration: "1700000000000",
    bindingId: randomUUID(),
    expectedPreviousGeneration: null,
  });
  for (const autoBind of [true, false]) {
    const f = await fixture();
    const machine = new FakeMachineV3(f.url, f.credential, () => ({ ok: true, result: null }), {
      autoBind,
    });
    cleanups.push(async () => machine.close());
    await machine.ready;
    await expect.poll(() => f.targets.transport(f.deviceId).catch(() => null)).not.toBeNull();
    const call = localCall(f.relay)(f.deviceId, "bindInstance", bindArgs(), {
      deadlineMs: 6000,
      signal: signal(),
    });
    if (autoBind)
      await expect(call).resolves.toMatchObject({ instanceGeneration: "1700000000000" });
    // the relay refuses a null bind result as unreadable
    else await expect(call).rejects.toThrow();
  }
});

it("a scripted answer reaches the relay and the frames are recorded", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential, (req) =>
    req.op === "create"
      ? { ok: true, result: { roots: { workspace: "/w", skills: "/s", tmp: "/t" } } }
      : undefined,
  );
  cleanups.push(async () => machine.close());
  await machine.ready;
  await expect.poll(() => f.targets.transport(f.deviceId).catch(() => null)).not.toBeNull();
  const result = await localCall(f.relay)(
    f.deviceId,
    "create",
    {
      name: "n",
      limits: {
        cpu: 1,
        memoryMb: 512,
        diskMb: 1024,
        network: { kind: "allowlist", hosts: [] },
      },
    },
    { deadlineMs: 6000, signal: signal() },
  );
  expect(result).toMatchObject({ roots: { workspace: "/w" } });
  expect(machine.frames.map((r) => (r.type === "req" ? r.op : r.type))).toEqual(["create"]);
});

it("helloEnvelope splits overrides between the envelope and the body", () => {
  const e = helloEnvelope({ bootId: "b1", programRunId: "run-1", roots: { a: 1 } });
  expect(e).toMatchObject({
    type: "hello",
    protocol: DEVICE_DIAL_IN_PROTOCOL,
    programRunId: "run-1",
    program: { version: "0.1.0", os: "linux", arch: "x64", bootId: "b1" },
    body: { ...HELLO_V3, roots: { a: 1 } },
  });
  expect(e.body).not.toHaveProperty("bootId");
});
