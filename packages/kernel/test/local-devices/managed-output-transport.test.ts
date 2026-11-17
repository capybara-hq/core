import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  type DeviceHelloV3,
  DeviceProtocolError,
  isSandboxScopeDeniedError,
  type KernelReadyV3,
  parseDeviceFrameV3,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { ApiError } from "../../src/errors.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { deviceLeaseKey, deviceReqKey } from "../../src/local-devices/keys.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import { DeviceRequestNotSentError, LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { type DeviceTargetState, DeviceTargets } from "../../src/local-devices/targets.js";
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
  let targetState: DeviceTargetState = "active";
  // What the fake device received: request ops and cancelled request ids.
  const requested = vi.fn<(op: string, id: string) => void>(),
    cancelled = vi.fn<(id: string) => void>();
  // Redis seam for the gateway: hold the capacity publication, or fail it a number of times.
  let publishGate: Promise<void> | undefined;
  let failPublishes = 0;
  const publishes = { ok: 0, failed: 0 };
  const gatewayRedis = new Proxy(redis, {
    get(target, prop, receiver) {
      if (prop === "set")
        return async (...a: Parameters<Redis["set"]>) => {
          const transportKey = String(a[0]).startsWith("capk:device-transport:");
          if (transportKey && failPublishes > 0) {
            failPublishes--;
            publishes.failed++;
            throw Error("injected transient Redis failure");
          }
          const r = await (target.set as (...x: unknown[]) => Promise<unknown>)(...a);
          if (transportKey) {
            publishes.ok++;
            await publishGate;
          }
          return r;
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
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
    background: {
      status: async () => ({ state: ended ? ("exited" as const) : ("running" as const) }),
    },
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
    gatewayRedis,
    config,
    log,
  );
  const relay = new LocalDeviceRelay(redis, bus, locks, config, log, {
    transport: targets.transport.bind(targets),
    state: async () => targetState,
  });
  const forbidden = vi.fn(() => {
    throw Error("No provision/native fallback is allowed");
  });
  const provider = new LocalDeviceProvider(
    relay,
    {
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
  const frames: string[] = [];
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
  const connect = async (cap = clientCap, waitReady = true) => {
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    let ready: KernelReadyV3 | undefined;
    const activeSocket = socket;
    socket.on("message", async (raw) => {
      const frame = parseDeviceFrameV3(raw.toString(), "kernel", ready?.maxFrameBytes ?? cap);
      frames.push(frame.type);
      if (frame.type === "ready") {
        ready = frame;
        return;
      }
      if (frame.type === "cancel") {
        cancelled(frame.id);
        return;
      }
      if (frame.type !== "req" || !ready) throw Error("Request before ready");
      requested(frame.op, frame.id);
      const a = frame.args,
        r = a.ref as typeof ref;
      if (frame.op === "backgroundStatus") {
        await beforeReply();
        // Like the device's session state, a non-read answer goes out on the current socket.
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            result: await backend.background.status(),
          }),
        );
        return;
      }
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
    const session = { ready: () => ready, socket: activeSocket };
    if (!waitReady) return session;
    await expect.poll(() => session.ready()).toBeDefined();
    await expect.poll(() => targets.transport(deviceId).catch(() => null)).not.toBeNull();
    return session;
  };
  const session = await connect();
  return {
    deviceId,
    relay,
    gateway,
    frames,
    requested,
    publishes,
    failPublishes: (n: number) => {
      failPublishes = n;
    },
    holdPublish: () => {
      let release!: () => void;
      publishGate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        publishGate = undefined;
        release();
      };
    },
    leaseHolder: () => locks.holderOf(deviceLeaseKey(deviceId)),
    setState: (s: DeviceTargetState) => {
      targetState = s;
    },
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
    read: (offset: number, maxBytes: number, s: AbortSignal = signal()) =>
      staged.background.readOutput(handle, ref, { offset, maxBytes, signal: s }),
    status: () => staged.background.status(handle, ref, signal()),
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
it("refuses another generation with a typed scope denial", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(10000, 66));
  const denied = await f.staged.background
    .readOutput(
      f.handle,
      { ...f.ref, instanceGeneration: "other" },
      { offset: 0, maxBytes: 1, signal: signal() },
    )
    .catch((e: unknown) => e);
  expect(denied).toBeInstanceOf(SandboxScopeDeniedError);
  expect(isSandboxScopeDeniedError(denied)).toBe(true);
});
it("a reconnect changes the exact capacity and fences requests of the old connection", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(10000, 66));
  const old = await f.targets.transport(f.handle.id);
  if (!old) throw Error("expected a transport");
  // The device sees a random connection id, never the gateway's lease token.
  expect(old.connectionId).toBe(f.session.ready()?.connectionId);
  expect(await f.leaseHolder()).not.toBe(old.connectionId);
  await f.disconnect();
  const next = await f.connect(66560);
  expect(next.ready()?.connectionId).not.toBe(old.connectionId);
  const stale = (op: "backgroundReadOutput" | "backgroundStatus") =>
    f.relay
      .callV3(
        f.handle.id,
        op,
        op === "backgroundReadOutput" ? { ref: f.ref, offset: 0, maxBytes: 3072 } : { ref: f.ref },
        { deadlineMs: 1000, signal: signal(), connection: old },
      )
      .then(
        () => {
          throw Error("expected the stale connection to be refused");
        },
        (e: unknown) => e as Error,
      );
  const read = await stale("backgroundReadOutput");
  expect(read.message).toContain("connection changed");
  expect(read.message).toContain("same offset");
  const status = await stale("backgroundStatus");
  expect(status.message).toContain("connection changed");
  expect(status.message).not.toContain("offset");
  // only operations held under an operation identity get the typed not-sent refusal
  for (const e of [read, status]) {
    expect(e).toBeInstanceOf(DeviceProtocolError);
    expect(e).not.toBeInstanceOf(DeviceRequestNotSentError);
  }
  // a held operation fenced to a replaced connection is refused before it is queued: not sent
  const revoke = await f.relay
    .callV3(
      f.handle.id,
      "revokeOperation",
      { ref: { operationId: "op", admitBeforeMs: Date.now() + 60_000 } },
      { deadlineMs: 1000, signal: signal(), connection: old },
    )
    .then(
      () => {
        throw Error("expected the stale connection to be refused");
      },
      (e: unknown) => e as Error,
    );
  expect(revoke).toBeInstanceOf(DeviceRequestNotSentError);
  expect(isSandboxScopeDeniedError(revoke)).toBe(true);
  expect(revoke.message).toContain("connection changed before revokeOperation was sent");
  expect(f.requested.mock.calls.map((c) => c[0])).not.toContain("revokeOperation");
  expect(await f.read(0, 65536)).toMatchObject({ nextOffset: 768 });
});
it("aborting an in-flight read cancels only that request and the task keeps running", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(100, 69));
  const held = f.holdReplies();
  const ctl = new AbortController();
  const pending = f.read(0, 10, ctl.signal).catch((e: unknown) => e);
  await held.ready;
  expect(f.requested.mock.calls.map((c) => c[0])).toEqual(["backgroundReadOutput"]);
  const id = f.requested.mock.calls[0]?.[1];
  ctl.abort(Error("cancel only read"));
  expect(await pending).toMatchObject({ message: "cancel only read" });
  // the give-up reached the device as a cancel of exactly that request
  await expect.poll(() => f.cancelled.mock.calls).toEqual([[id]]);
  held.release();
  expect(await f.status()).toEqual({ state: "running" });
  expect(f.requested.mock.calls.map((c) => c[0])).toEqual([
    "backgroundReadOutput",
    "backgroundStatus",
  ]);
  expect(f.forbidden).not.toHaveBeenCalled();
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
  expect(await pending).toMatchObject({
    message: expect.stringContaining("retry the read from the same offset"),
  });
  expect(await f.read(0, 65536)).toMatchObject({ offset: 0, nextOffset: 768 });
  // giving the read up cancels only that read on the machine, never the task
  const readId = f.requested.mock.calls[0]?.[1];
  for (const [id] of f.cancelled.mock.calls) expect(id).toBe(readId);
  expect(await f.status()).toEqual({ state: "running" });
});

it("a non-read result answered after a reconnect within grace is delivered, not discarded", async () => {
  const f = await fixture();
  const held = f.holdReplies();
  const pending = f.status().catch((e: unknown) => e);
  await held.ready;
  await f.disconnect();
  await f.connect(66560);
  held.release();
  expect(await pending).toEqual({ state: "running" });
  expect(f.cancelled).not.toHaveBeenCalled();
});

it.each([
  ["deleted", "device.not_found"],
  ["revoked", "device.forbidden"],
] as const)("a %s device yields %s from output reads and other staged ops", async (state, code) => {
  const f = await fixture();
  await f.disconnect();
  f.setState(state);
  const read = await f.read(0, 1).catch((e: unknown) => e);
  expect(read).toBeInstanceOf(ApiError);
  expect(read).toMatchObject({ code });
  expect(await f.status().catch((e: unknown) => e)).toMatchObject({ code });
});
it("an active device without a connection yields device.offline", async () => {
  const f = await fixture();
  await f.disconnect();
  expect(await f.read(0, 1).catch((e: unknown) => e)).toMatchObject({ code: "device.offline" });
});

it("closes a staged connection whose device answers before ready", async () => {
  const f = await fixture();
  await f.disconnect();
  const release = f.holdPublish();
  const s = await f.connect(69632, false);
  const closed = once(s.socket, "close");
  s.socket.send(JSON.stringify({ type: "res", id: "early", ok: true, result: null }));
  expect((await closed)[0]).toBe(4400);
  release();
});
it("publishes capacity before ready and holds queued requests until ready", async () => {
  const f = await fixture();
  await f.emit(Buffer.alloc(10, 70));
  await f.disconnect();
  f.frames.length = 0;
  const release = f.holdPublish();
  const s = await f.connect(69632, false);
  await expect.poll(() => f.targets.transport(f.deviceId).catch(() => null)).not.toBeNull();
  // capacity is readable, yet ready has not been sent: a reader never sees "not ready" after it
  expect(s.ready()).toBeUndefined();
  const pending = f.read(0, 10);
  await expect.poll(() => redis.llen(deviceReqKey(f.deviceId))).toBe(1);
  expect(f.frames).toEqual([]);
  release();
  expect(await pending).toMatchObject({ nextOffset: 10 });
  expect(f.frames).toEqual(["ready", "req"]);
});
it("tolerates one transient capacity publication failure on ping and closes after repeated ones", async () => {
  const f = await fixture();
  await f.disconnect();
  f.gateway.pingIntervalMs = 50;
  const s = await f.connect();
  f.failPublishes(1);
  await expect.poll(() => f.publishes.failed).toBe(1);
  const ok = f.publishes.ok;
  await expect.poll(() => f.publishes.ok).toBeGreaterThan(ok + 1);
  expect(s.socket.readyState).toBe(WebSocket.OPEN);
  expect(f.gateway.connectionCount()).toBe(1);
  expect(await f.read(0, 0)).toMatchObject({ nextOffset: 0 });
  const closed = once(s.socket, "close");
  f.failPublishes(10);
  expect((await closed)[0]).toBe(1011);
});
