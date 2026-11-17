import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { DeviceTargets } from "../../src/local-devices/targets.js";
import { createLogger } from "../../src/log.js";
import { FakeMachineV3, fakeMachineFor, HELLO_V3 } from "./fake-machine-v3.js";

/**
 * The staged fake machine (permission activation B-28) against the real gateway's `acceptStaged`:
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
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("no address");
  server.on("connection", (socket) => {
    void gateway.acceptStaged(socket, credential);
  });
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  cleanups.push(() => gateway.stop());
  const url = `ws://127.0.0.1:${address.port}`;
  return { deviceId, credential, url, machines, relay, targets };
}

const signal = () => AbortSignal.timeout(15000);

it("a staged fake machine's hello is recorded with the connection id of its ready frame", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential);
  cleanups.push(async () => machine.close());
  const ready = await machine.ready;
  await expect.poll(() => f.machines.recordHelloV3.mock.calls.length).toBe(1);
  const [, hello, connectionId] = f.machines.recordHelloV3.mock.calls[0] as unknown as [
    string,
    typeof HELLO_V3,
    string,
  ];
  expect(hello).toMatchObject({ protocol: 3, ownerCeiling: HELLO_V3.ownerCeiling });
  expect(connectionId).toBe(ready.connectionId);
  expect(f.machines.recordHello).not.toHaveBeenCalled();
});

it("hello overrides carry v2-only fields (features, policy) on a staged hello", async () => {
  const f = await fixture();
  const machine = new FakeMachineV3(f.url, f.credential, undefined, { hello: false });
  cleanups.push(async () => machine.close());
  await machine.opened;
  machine.hello({ features: ["policyOp"], policy: { mode: "sandbox", allowedDomains: [] } });
  await machine.ready;
  await expect.poll(() => f.machines.recordHelloV3.mock.calls.length).toBe(1);
  expect((f.machines.recordHelloV3.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
    features: ["policyOp"],
    policy: { mode: "sandbox", allowedDomains: [] },
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
  const result = await f.relay.callV3(f.deviceId, "bindInstance", args, {
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
    permissionSupport: { fullAccess: true, background: true },
  });
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
  const result = await f.relay.callV3(
    f.deviceId,
    "create",
    {
      name: "n",
      limits: {
        cpu: 1,
        memoryMb: 512,
        diskMb: 1024,
        mode: "sandbox",
        network: { kind: "allowlist", hosts: [] },
      },
    },
    { deadlineMs: 6000, signal: signal() },
  );
  expect(result).toMatchObject({ roots: { workspace: "/w" } });
  expect(machine.frames.map((r) => (r.type === "req" ? r.op : r.type))).toEqual(["create"]);
});

it("fakeMachineFor picks the machine and hello of a protocol", () => {
  expect(fakeMachineFor(3).Machine).toBe(FakeMachineV3);
  expect(fakeMachineFor(3).protocolHeader).toBe("3");
  expect(fakeMachineFor(2).protocolHeader).toBe("2");
  expect(fakeMachineFor(2).HELLO.protocol).toBe(2);
  expect(fakeMachineFor(3).helloWith({ bootId: "b1" })).toMatchObject({
    protocol: 3,
    bootId: "b1",
  });
});
