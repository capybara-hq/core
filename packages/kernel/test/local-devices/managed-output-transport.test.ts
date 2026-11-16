import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  type DeviceHelloV3,
  type KernelReadyV3,
  parseDeviceFrameV3,
} from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { DeviceTargets } from "../../src/local-devices/targets.js";
import { createLogger } from "../../src/log.js";

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

async function fixture(clientCap = 69632, serverCap = 100000) {
  const deviceId = randomUUID(),
    credential = randomUUID();
  const roots = { workspace: "/fixture/workspace", skills: "/fixture/skills", tmp: "/fixture/tmp" };
  let output = Buffer.alloc(0),
    expired = false,
    ended = false;
  const cancelled = vi.fn(),
    launched = vi.fn();
  const handle = { id: deviceId };
  const ref = {
    instanceId: deviceId,
    instanceGeneration: "g",
    operationId: "op",
    executionId: "e",
  };
  const backend = {
    permissionSupport: async () => ({
      version: 1 as const,
      restricted: null,
      fullAccess: false,
      background: false,
    }),
    background: { status: async () => ({ state: ended ? "exited" : "running" }) },
  };
  const bus = createBus(redis, sub, `test-${deviceId}`),
    locks = new LockService(redis, createLogger("error", { write: () => {} }));
  const config = {
    get: () => ({
      devices: { local: { maxFrameBytes: serverCap, leaseTtlMs: 6000, reconnectGraceSeconds: 1 } },
    }),
  } as KernelConfigService;
  const targets = new DeviceTargets({} as KernelDb, redis, locks);
  const gateway = new LocalDeviceGateway(
    {
      authenticate: async (c) =>
        c === credential
          ? { deviceId, machineId: "machine", orgId: "org", accountId: "owner" }
          : null,
      recordHello: async () => {},
      recordPolicy: async () => {},
      touch: async () => {},
    },
    locks,
    bus,
    redis,
    config,
    log,
  );
  const relay = new LocalDeviceRelay(redis, bus, locks, config, log, {
    transport: targets.transport.bind(targets),
    state: async () => "active",
  });
  const forbidden = vi.fn(() => {
    throw Error("No provision/native fallback is allowed");
  });
  const provider = new LocalDeviceProvider(
    relay,
    {
      transport: targets.transport.bind(targets),
      orgOf: forbidden,
      machineRoots: forbidden,
      machineFeatures: forbidden,
    },
    { devicePolicy: forbidden, deviceLimits: forbidden },
    config,
    { forExec: forbidden, reportedMode: forbidden },
    log,
  );
  const staged = provider.stagedOperations({
    call: relay.callV3.bind(relay),
    permissionSupport: backend.permissionSupport,
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error();
  server.on("connection", (socket) => {
    void gateway.acceptStaged(socket, credential);
  });
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  cleanups.push(() => gateway.stop());
  let socket: WebSocket;
  let beforeReply = async () => {};
  const hello: DeviceHelloV3 = {
    type: "hello",
    protocol: 3,
    programVersion: "fixture",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots,
    sessionIsolation: false,
    transport: { maxFrameBytes: clientCap },
    permissionSupport: { version: 1, restricted: null, fullAccess: false, background: false },
    ownerCeiling: {
      version: 2,
      sequence: 0,
      restrictedProjectReach: "workspace",
      revision: "r",
      fullAccess: false,
      restrictedAllowedDomains: [],
    },
    instanceGeneration: "g",
  };
  const connect = async (cap = clientCap) => {
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    let ready: KernelReadyV3 | undefined;
    const activeSocket = socket;
    socket.on("message", async (raw) => {
      const frame = parseDeviceFrameV3(raw.toString(), "kernel", ready?.maxFrameBytes ?? cap);
      if (frame.type === "ready") {
        ready = frame;
        return;
      }
      if (frame.type === "cancel") return;
      if (frame.type !== "req" || !ready) throw Error("Request before ready");
      const a = frame.args,
        r = a.ref as typeof ref;
      const result = expired
        ? { unavailable: "expired" }
        : {
            dataB64: output
              .subarray(a.offset as number, (a.offset as number) + (a.maxBytes as number))
              .toString("base64"),
            offset: a.offset,
            nextOffset:
              (a.offset as number) +
              Math.min(a.maxBytes as number, Math.max(0, output.length - (a.offset as number))),
            totalBytes: output.length,
          };
      await beforeReply();
      if (activeSocket.readyState !== activeSocket.OPEN) return;
      activeSocket.send(
        JSON.stringify(
          r.instanceGeneration !== "g"
            ? {
                type: "res",
                id: frame.id,
                ok: false,
                error: { kind: "denied", message: "Check exact instance generation" },
              }
            : { type: "res", id: frame.id, ok: true, result },
        ),
      );
    });
    socket.send(JSON.stringify({ ...hello, transport: { maxFrameBytes: cap } }));
    const session = { ready: () => ready };
    await expect.poll(() => session.ready()).toBeDefined();
    await expect.poll(() => targets.transport(deviceId).catch(() => null)).not.toBeNull();
    return session;
  };
  const session = await connect();
  return {
    relay,
    holdReplies: () => {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      beforeReply = async () => {
        entered();
        await gate;
      };
      return {
        ready,
        release: () => {
          beforeReply = async () => {};
          release();
        },
      };
    },
    ref,
    backend,
    handle,
    staged,
    targets,
    session,
    forbidden,
    cancelled,
    launched,
    emit: async (b: Buffer) => {
      output = Buffer.concat([output, b]);
    },
    finish: () => {
      ended = true;
    },
    expire: () => {
      expired = true;
    },
    disconnect: async () => {
      const ended = once(socket, "close");
      socket.close();
      await ended;
      await expect.poll(() => gateway.connectionCount()).toBe(0);
    },
    connect,
    read: (offset: number, maxBytes: number) =>
      staged.background.readOutput(handle, ref, { offset, maxBytes, signal: signal() }),
  };
}

it.each([
  [69632, 100000],
  [100000, 69632],
])(
  "negotiates client %i/server %i and forwards >65KiB through real provider, relay and sockets",
  async (client, server) => {
    const f = await fixture(client, server);
    expect(f.session.ready()?.maxFrameBytes).toBe(69632);
    const data = Buffer.alloc(180000, 65);
    await f.emit(data);
    const probe = await f.read(0, 0);
    expect(probe).toMatchObject({
      offset: 0,
      nextOffset: 0,
      totalBytes: data.length,
      data: new Uint8Array(),
    });
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
      const r = await f.read(offset, 65536);
      if ("unavailable" in r) throw Error(r.unavailable);
      expect(r.data.length).toBe(Math.min(3072, data.length - offset));
      parts.push(Buffer.from(r.data));
      offset = r.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(data);
    expect(await f.read(data.length + 10, 100)).toMatchObject({
      offset: data.length + 10,
      nextOffset: data.length + 10,
      totalBytes: data.length,
      data: new Uint8Array(),
    });
    f.finish();
    await expect.poll(() => f.backend.background.status()).toMatchObject({ state: "exited" });
    expect(await f.read(0, 4)).toMatchObject({ nextOffset: 4 });
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.cancelled).not.toHaveBeenCalled();
    f.expire();
    expect(await f.read(0, 4)).toEqual({ unavailable: "expired" });
  },
);
it("rejects another generation and preserves task on read cancellation; reconnect changes the exact capacity", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(10000, 66));
  await expect(
    f.staged.background.readOutput(
      f.handle,
      { ...f.ref, instanceGeneration: "other" },
      { offset: 0, maxBytes: 1, signal: signal() },
    ),
  ).rejects.toThrow();
  const old = await f.targets.transport(f.handle.id);
  await f.disconnect();
  const next = await f.connect(66560);
  expect(next.ready()?.connectionId).not.toBe(old.connectionId);
  await expect(
    f.relay.callV3(
      f.handle.id,
      "backgroundReadOutput",
      { ref: f.ref, offset: 0, maxBytes: 3072 },
      { deadlineMs: 1000, signal: signal(), connection: old },
    ),
  ).rejects.toThrow("capacity changed");
  expect(await f.read(0, 65536)).toMatchObject({ nextOffset: 768 });
  const ctl = new AbortController();
  ctl.abort(Error("cancel only read"));
  await expect(
    f.staged.background.readOutput(f.handle, f.ref, {
      offset: 768,
      maxBytes: 10,
      signal: ctl.signal,
    }),
  ).rejects.toThrow("cancel only read");
  expect(await f.backend.background.status()).toEqual({ state: "running" });
  expect(f.cancelled).not.toHaveBeenCalled();
});
it("zero capacity preserves probes and refuses data with an actionable error", async () => {
  const f = await fixture(65536, 100000);
  expect(await f.read(0, 1)).toMatchObject({ totalBytes: 0, nextOffset: 0 });
  await f.emit(Buffer.from("output"));
  expect(await f.read(0, 0)).toMatchObject({ totalBytes: 6, nextOffset: 0 });
  await expect(f.read(0, 1)).rejects.toThrow("increase device and deployment frame limits");
  expect(f.cancelled).not.toHaveBeenCalled();
});

it("a reconnect during a pending range refuses the old connection and retries at the same offset", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(10000, 68));
  const held = f.holdReplies();
  const pending = f.read(0, 65536).catch((e: unknown) => e);
  await held.ready;
  await f.disconnect();
  await f.connect(66560);
  held.release();
  expect(await pending).toMatchObject({ message: expect.stringContaining("capacity changed") });
  expect(await f.read(0, 65536)).toMatchObject({ offset: 0, nextOffset: 768 });
  expect(f.cancelled).not.toHaveBeenCalled();
});
