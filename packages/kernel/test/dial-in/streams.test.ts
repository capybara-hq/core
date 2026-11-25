import { randomUUID } from "node:crypto";
import type { DeviceStream } from "@capybara-hq/plugin-sdk";
import {
  FakeDialInMachine,
  type FakeMachineStream,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DialInGateway } from "../../src/dial-in/gateway.js";
import { deviceHolderAddrKey, deviceLeaseKey } from "../../src/dial-in/keys.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { DEVICE_STREAM_MESSAGE_TOO_BIG } from "../../src/dial-in/streams.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createOrg,
  enableExtensions,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Direct device streams on the dial-in connection (browser use spec §6.1): the gateway replica
 * holding the machine's socket opens a stream to the machine and relays its frames over that
 * socket only, with per-stream credit. Driven with the `fake-dial-in` fixture provider and
 * `FakeDialInMachine`.
 */

const MAX_FRAME_BYTES = 64 * 1024;
const INTERNAL_URL = "http://10.0.0.5:8080";
const HELLO = { revision: "r1", outsideSandbox: false };

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let gateway: DialInGateway;
let machines: DialInMachines;
let devices: DevicesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
const open: FakeDialInMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        gateway: { internalUrl: INTERNAL_URL },
        devices: {
          dialIn: { reconnectGraceSeconds: 5, leaseTtlMs: 6000, maxFrameBytes: MAX_FRAME_BYTES },
        },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  gateway = k.app.get(DialInGateway);
  machines = k.app.get(DialInMachines);
  devices = k.app.get(DevicesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  await enableExtensions(raw, orgId, "fake-dial-in");
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterAll(async () => {
  for (const m of open.splice(0)) await m.close().catch(() => {});
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member's `fake-dial-in` device with a signed-in machine credential (not connected). */
async function signedIn() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  return txHost.run(async () => {
    const { id: deviceId } = await devices.createDialIn(orgId, accountId, "fake-dial-in", "Box");
    const issued = await machines.issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
}

/** A connected machine whose streams go to `onStream`; resolves once this replica holds it. */
async function connected(
  onStream?: (open: unknown, s: FakeMachineStream) => void,
  opts: { binaryStreamData?: boolean } = {},
) {
  const m = await signedIn();
  const machine = await FakeDialInMachine.connect({
    url,
    credential: m.credential,
    hello: HELLO,
    ...opts,
  });
  open.push(machine);
  if (onStream) machine.onStream(onStream);
  await waitFor(async () => gateway.holdsLocally(m.deviceId), 10_000, "holding");
  return { ...m, machine };
}

/** Opens a stream on the holding replica and resolves the kernel's end and the machine's. */
async function openPair(): Promise<{
  deviceId: string;
  machine: FakeDialInMachine;
  stream: DeviceStream;
  peer: FakeMachineStream;
}> {
  let peer: FakeMachineStream | undefined;
  const c = await connected((_open, s) => {
    peer = s;
  });
  const stream = await gateway.openStream(
    c.deviceId,
    { target: "echo" },
    AbortSignal.timeout(10_000),
  );
  return { deviceId: c.deviceId, machine: c.machine, stream, peer: peer as FakeMachineStream };
}

const bytes = (i: number) => new TextEncoder().encode(`message ${i}`);

describe("dial-in streams", () => {
  it("stream echoes 100 messages in order", async () => {
    let target: unknown;
    let peer: FakeMachineStream | undefined;
    const c = await connected((o, s) => {
      target = o;
      peer = s;
      s.onMessage((m) => void s.send(m));
    });
    const stream = await gateway.openStream(
      c.deviceId,
      { target: "echo" },
      AbortSignal.timeout(10_000),
    );
    expect(target).toEqual({ target: "echo" });
    const got: Uint8Array[] = [];
    const collected = (async () => {
      for await (const m of stream.messages) {
        got.push(m);
        if (got.length === 100) break;
      }
    })();
    for (let i = 0; i < 100; i++) await stream.send(bytes(i));
    await collected;
    expect(got.map((m) => new TextDecoder().decode(m))).toEqual(
      Array.from({ length: 100 }, (_, i) => `message ${i}`),
    );
    // breaking the loop closed the stream, the machine's side too
    expect(await stream.closed).toEqual({ reason: "consumer stopped" });
    expect(await peer?.closed).toEqual({ reason: "consumer stopped" });
  });

  it("a consumer that throws closes the stream on both sides", async () => {
    const { stream, peer } = await openPair();
    await peer.send(bytes(1));
    await expect(
      (async () => {
        for await (const _m of stream.messages) throw new Error("consumer failed");
      })(),
    ).rejects.toThrow("consumer failed");
    expect(await stream.closed).toEqual({ reason: "consumer stopped" });
    expect(await peer.closed).toEqual({ reason: "consumer stopped" });
  });

  it("a second concurrent next() is refused", async () => {
    const { stream, peer } = await openPair();
    const it = stream.messages[Symbol.asyncIterator]();
    const first = it.next();
    await expect(it.next()).rejects.toThrow(/one consumer/);
    await peer.send(bytes(7));
    const r = await first;
    expect(new TextDecoder().decode(r.value as Uint8Array)).toBe("message 7");
    stream.close();
  });

  it("an open the machine never answers times out and is closed", async () => {
    const c = await connected();
    c.machine.ignoreStreamOpens = true;
    const before = gateway.streamOpenTimeoutMs;
    gateway.streamOpenTimeoutMs = 300;
    try {
      await expect(
        gateway.openStream(c.deviceId, { target: "x" }, new AbortController().signal),
      ).rejects.toThrow(/did not answer the stream open within 300 ms/);
    } finally {
      gateway.streamOpenTimeoutMs = before;
    }
    const opened = c.machine.streamOpens[0];
    expect(opened).toBeDefined();
    await waitFor(
      async () => c.machine.streamCloses.includes(opened as string),
      10_000,
      "stream-close of the unanswered open",
    );
  });

  it("sender waits for credit", async () => {
    const { stream, peer } = await openPair();
    peer.autoCredit = false;
    for (let i = 0; i < 8; i++) await stream.send(bytes(i));
    let ninthSent = false;
    const ninth = stream.send(bytes(8)).then(() => {
      ninthSent = true;
    });
    await peer.receivedCount(8);
    expect(ninthSent).toBe(false);
    await peer.grant(1);
    await ninth;
    expect(ninthSent).toBe(true);
    await peer.receivedCount(9);
    expect(new TextDecoder().decode(peer.received[8])).toBe("message 8");
    stream.close();
  });

  it("message above the connection's maxFrameBytes is refused", async () => {
    const { stream, peer } = await openPair();
    await expect(stream.send(new Uint8Array(MAX_FRAME_BYTES))).rejects.toThrow(/frame capacity/);
    // identifiable by its code (the viewer endpoint answers it with 1009)
    await expect(stream.send(new Uint8Array(MAX_FRAME_BYTES))).rejects.toMatchObject({
      code: DEVICE_STREAM_MESSAGE_TOO_BIG,
    });
    // the stream stays usable for messages that fit
    await stream.send(bytes(1));
    await peer.receivedCount(1);
    stream.close();
  });

  it("stream data goes binary both ways once hello and ready agree", async () => {
    let peer: FakeMachineStream | undefined;
    const c = await connected(
      (_o, s) => {
        peer = s;
        s.onMessage((m) => void s.send(m));
      },
      { binaryStreamData: true },
    );
    expect(c.machine.binaryStreamData).toBe(true);
    const stream = await gateway.openStream(
      c.deviceId,
      { target: "echo" },
      AbortSignal.timeout(10_000),
    );
    const got: Uint8Array[] = [];
    const collected = (async () => {
      for await (const m of stream.messages) {
        got.push(m);
        if (got.length === 3) break;
      }
    })();
    // raw bytes of every value survive (no text encoding on the way)
    const sent = [bytes(1), Uint8Array.of(0, 255, 128, 1), new Uint8Array()];
    for (const m of sent) await stream.send(m);
    await collected;
    expect(got.map((m) => [...m])).toEqual(sent.map((m) => [...m]));
    expect(c.machine.binaryReceived).toBe(3);
    expect(peer?.received).toHaveLength(3);
    // a message too large for one frame once base64-encoded fits as binary
    const big = new Uint8Array(MAX_FRAME_BYTES - 100);
    const second = await openPair();
    await expect(second.stream.send(big)).rejects.toMatchObject({
      code: DEVICE_STREAM_MESSAGE_TOO_BIG,
    });
    second.stream.close();
    let bigPeer: FakeMachineStream | undefined;
    const d = await connected(
      (_o, s) => {
        bigPeer = s;
      },
      { binaryStreamData: true },
    );
    const bigStream = await gateway.openStream(
      d.deviceId,
      { target: "x" },
      AbortSignal.timeout(10_000),
    );
    await bigStream.send(big);
    await bigPeer?.receivedCount(1);
    expect(bigPeer?.received[0]?.byteLength).toBe(big.byteLength);
    bigStream.close();
  });

  it("a machine that did not offer binary stream data stays on JSON", async () => {
    const { machine, stream, peer } = await openPair();
    expect(machine.binaryStreamData).toBe(false);
    await stream.send(bytes(1));
    await peer.receivedCount(1);
    expect(machine.binaryReceived).toBe(0);
    // nothing binary reached it, agreed or not
    expect(machine.invalid).toEqual([]);
    stream.close();
  });

  it("a binary message the connection did not agree on closes the socket", async () => {
    const { machine } = await openPair();
    // the fake machine sends only what the ready agreed; this one sends binary anyway
    (machine as unknown as { ws: { send(b: Uint8Array): void } }).ws.send(
      Uint8Array.of(1, 1, 115, 7),
    );
    expect((await machine.closed).code).toBe(4400);
  });

  it("binary sent after the hello but before ready closes the socket", async () => {
    const m = await signedIn();
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${m.credential}`,
        "x-capybara-device-protocol": "fake-dial-in/1",
      },
    });
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: "fake-dial-in/1",
        programRunId: randomUUID(),
        program: { version: "0.0.0-fake", os: "linux", arch: "x64" },
        transport: { maxFrameBytes: MAX_FRAME_BYTES, binaryStreamData: true },
        body: HELLO,
      }),
    );
    // in the same tick: the kernel has not answered ready yet
    ws.send(Uint8Array.of(1, 2, 115, 49, 7));
    expect(await closed).toBe(4400);
  });

  it("a binary message over the connection's effective capacity closes the socket", async () => {
    const m = await signedIn();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: m.credential,
      hello: HELLO,
      // the machine announces less than the kernel's limit: the effective cap is its own
      maxFrameBytes: 8 * 1024,
      binaryStreamData: true,
    });
    open.push(machine);
    expect(machine.maxFrameBytes).toBe(8 * 1024);
    const big = Buffer.concat([Buffer.from([1, 2]), Buffer.from("s1"), Buffer.alloc(9 * 1024)]);
    (machine as unknown as { ws: { send(b: Uint8Array): void } }).ws.send(big);
    expect((await machine.closed).code).toBe(4400);
  });

  it("stream closes when the machine socket drops", async () => {
    const { stream, machine } = await openPair();
    await machine.close();
    expect(await stream.closed).toEqual({ reason: "device-offline" });
    await expect(stream.send(bytes(1))).rejects.toThrow(/closed/);
  });

  it("the machine's close reaches the kernel's end", async () => {
    const { stream, peer } = await openPair();
    await peer.close("target gone");
    expect(await stream.closed).toEqual({ reason: "target gone" });
  });

  it("a stream the machine refuses fails to open", async () => {
    const c = await connected(() => {
      throw new Error("no such target");
    });
    await expect(
      gateway.openStream(c.deviceId, { target: "x" }, AbortSignal.timeout(10_000)),
    ).rejects.toThrow(/no such target/);
  });

  it("requests still flow while a stream is saturated", async () => {
    const { deviceId, machine, stream, peer } = await openPair();
    peer.autoCredit = false;
    for (let i = 0; i < 8; i++) await stream.send(bytes(i));
    const pending = stream.send(bytes(8));
    machine.onRequest((body) => ({ echoed: body }));
    const res = await k.http.inject({
      method: "POST",
      url: "/plugins/fake-dial-in/request",
      headers: { "content-type": "application/json" },
      payload: { deviceId, body: { ping: 1 }, timeoutMs: 5000 },
    });
    expect(JSON.parse(res.body)).toEqual({ ok: true, body: { echoed: { ping: 1 } } });
    stream.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("ctx.dialIn.openStream opens a stream on the holding replica", async () => {
    const c = await connected((_o, s) => s.onMessage((m) => void s.send(m)));
    const res = await k.http.inject({
      method: "POST",
      url: "/plugins/fake-dial-in/stream",
      headers: { "content-type": "application/json" },
      payload: { deviceId: c.deviceId, body: { target: "echo" }, message: "hello" },
    });
    expect(JSON.parse(res.body)).toEqual({ ok: true, echo: "hello" });
  });

  it("holder address is written with the lease", async () => {
    const c = await connected();
    const key = deviceHolderAddrKey(c.deviceId);
    expect(key).toBe(`capk:device-holder-addr:${c.deviceId}`);
    const token = await redis.get(deviceLeaseKey(c.deviceId));
    expect(JSON.parse((await redis.get(key)) ?? "null")).toEqual({
      token,
      address: INTERNAL_URL,
    });
    expect(await redis.pttl(key)).toBeGreaterThan(0);
    expect(await gateway.holderAddress(c.deviceId)).toBe(INTERNAL_URL);
    await c.machine.close();
    await waitFor(async () => (await redis.get(key)) === null, 10_000, "address removed");
  });

  it("holder address is read only under the current lease token", async () => {
    const deviceId = randomUUID();
    const key = deviceHolderAddrKey(deviceId);
    const lease = deviceLeaseKey(deviceId);
    await redis.set(key, JSON.stringify({ token: "t-old", address: "http://old:1" }), "PX", 60_000);
    // the lease expired (the holder is gone): no address
    expect(await gateway.holderAddress(deviceId)).toBeNull();
    // a takeover holds the lease before writing its address: never the old one
    await redis.set(lease, "t-new", "PX", 60_000);
    expect(await gateway.holderAddress(deviceId)).toBeNull();
    await redis.set(key, JSON.stringify({ token: "t-new", address: "http://new:2" }), "PX", 60_000);
    expect(await gateway.holderAddress(deviceId)).toBe("http://new:2");
    await redis.del(key, lease);
  });

  it("openStream on a replica without the socket throws DialInStreamElsewhereError", async () => {
    const m = await signedIn();
    // another replica's connection holds the lease
    await redis.set(deviceLeaseKey(m.deviceId), randomUUID(), "PX", 30_000);
    const res = await k.http.inject({
      method: "POST",
      url: "/plugins/fake-dial-in/stream",
      headers: { "content-type": "application/json" },
      payload: { deviceId: m.deviceId, body: { target: "echo" } },
    });
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      error: { name: "DialInStreamElsewhereError", code: "device.stream_elsewhere" },
    });
    await redis.del(deviceLeaseKey(m.deviceId));
    // nobody holds it: offline
    const offline = await k.http.inject({
      method: "POST",
      url: "/plugins/fake-dial-in/stream",
      headers: { "content-type": "application/json" },
      payload: { deviceId: m.deviceId, body: { target: "echo" } },
    });
    expect(JSON.parse(offline.body)).toMatchObject({
      ok: false,
      error: { code: "device.offline" },
    });
  });
});
