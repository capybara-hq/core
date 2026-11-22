import { randomUUID } from "node:crypto";
import {
  type DeviceProvider,
  ExtensionPermissionError,
  isDeviceOfflineError,
} from "@capybara-hq/plugin-sdk";
import {
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DEVICE_CLOSE, MAX_EVENTS_IN_FLIGHT } from "../../src/dial-in/gateway.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { DialInRelay } from "../../src/dial-in/relay.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
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
 * The generic dial-in channel (device provider spec §5): `GET /device/connect` routes a machine
 * credential to the provider of its device (`permissions.dialIn`), the gateway speaks the envelope
 * and hands the bodies to the provider's `dialIn` handler, and the provider talks to its own
 * machines only through `ctx.dialIn`. Driven with the `fake-dial-in` fixture provider and
 * `FakeDialInMachine`.
 */

const GRACE_SECONDS = 2;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let ownerId: string;
let orgId: string;
let url: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  // an optional preinstall: loaded on the deployment, on only in the orgs that switch it on
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        devices: { maxPersonal: 50, local: { reconnectGraceSeconds: GRACE_SECONDS } },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  await enableExtensions(raw, orgId, "fake-dial-in");
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/**
 * A device of `provider` with a signed-in machine (the machine row issued directly: signing in by
 * provider is the sign-in's own task). `fake-dial-in` devices keep `source = local`, which the
 * credential check reads until the local semantics leave the kernel.
 */
async function device(provider = "fake-dial-in") {
  const { id: deviceId } = await k.app
    .get(TransactionHost)
    .run(() =>
      k.app.get(DevicesService).createLocal(orgId, ownerId, `Box ${randomUUID().slice(0, 8)}`),
    );
  await sql`UPDATE capybara.devices SET provider = ${provider} WHERE id = ${deviceId}`.execute(raw);
  const issued = await k.app.get(TransactionHost).run(() =>
    k.app.get(DialInMachines).issue({
      orgId,
      deviceId,
      accountId: ownerId,
      name: "fake",
      os: "linux",
      arch: "x64",
      programVersion: "0.0.0",
    }),
  );
  return { deviceId, ...issued };
}

/** What the fixture keeps in its `ctx.kv` (`cap:fake-dial-in:kv:<key>`). */
const kv = (key: string) => redis.get(`cap:fake-dial-in:kv:${key}`);

const provider = (): DeviceProvider => {
  const impl = k.app.get(DeviceProviders).forDevice("fake-dial-in")?.impl;
  if (!impl) throw new Error("fake-dial-in is not loaded");
  return impl;
};

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("GET /device/connect routes by the device's provider", () => {
  it("routes a credential to its device provider and opens the socket", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1", outsideSandbox: false },
    });
    expect(machine.connectionId).toEqual(expect.any(String));
    // ready carries the effective capacity: the 1 MiB announced, under the kernel's 16 MiB default
    expect(machine.maxFrameBytes).toBe(1024 * 1024);
    // the provider accepted the body; the kernel recorded the envelope's program facts
    expect(JSON.parse((await kv(`hello:${d.deviceId}`)) ?? "{}")).toEqual({
      revision: "r1",
      outsideSandbox: false,
    });
    expect(
      await db
        .selectFrom("device_machines")
        .select(["program_version", "os", "arch"])
        .where("id", "=", d.machineId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ program_version: "0.0.0-fake", os: "linux", arch: "x64" });
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(true);
    await machine.close();
  });

  it("answers 426 when the protocol header differs from the provider's declaration", async () => {
    const d = await device();
    const e = (await rejection(
      FakeDialInMachine.connect({
        url,
        credential: d.credential,
        protocol: "capybara-device/5",
        hello: {},
      }),
    )) as Error;
    expect(e.message).toContain("HTTP 426");
    expect(e.message).toContain("device.program_outdated");
    expect(e.message).toContain(FAKE_DIAL_IN_PROTOCOL);
  });

  it("answers 403 device.provider_unavailable when the device's provider is off in the org", async () => {
    const d = await device();
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE plugin = 'fake-dial-in' AND org_id = ${orgId}`.execute(raw);
    try {
      const e = (await rejection(
        FakeDialInMachine.connect({ url, credential: d.credential, hello: {} }),
      )) as Error;
      expect(e.message).toContain("HTTP 403");
      expect(e.message).toContain("device.provider_unavailable");
    } finally {
      await enableExtensions(raw, orgId, "fake-dial-in");
    }
  });

  it("closes 4400 with the provider's code when onHello refuses, without claiming the lease", async () => {
    const d = await device();
    const e = (await rejection(
      FakeDialInMachine.connect({ url, credential: d.credential, hello: { refuse: "nope" } }),
    )) as Error;
    expect(e.message).toContain(`closed before ready: ${DEVICE_CLOSE.protocol}`);
    expect(e.message).toContain("fake.refused: nope");
    expect(await kv(`hello:${d.deviceId}`)).toBeNull();
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(false);
  });

  it("closes 4400 on a frame over maxFrameBytes without calling onFrame", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
      maxFrameBytes: 2048,
    });
    expect(machine.maxFrameBytes).toBe(2048);
    // within the negotiated capacity: handed to the provider
    await machine.send({ revision: "r2" });
    await waitFor(() => kv(`frame:${d.deviceId}`));
    await redis.del(`cap:fake-dial-in:kv:frame:${d.deviceId}`);
    // over the 2048 bytes the machine announced (below the kernel's own limit): closed, unread
    await machine.send({ revision: "x".repeat(3000) });
    expect((await machine.closed).code).toBe(DEVICE_CLOSE.protocol);
    expect(await kv(`frame:${d.deviceId}`)).toBeNull();
  });

  it("onClose receives replaced when a newer connection of the same credential takes over", async () => {
    const d = await device();
    const first = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    const second = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    expect((await first.closed).code).toBe(DEVICE_CLOSE.replaced);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "replaced" ? true : null));
    // the machine revoked as its device is deleted: the provider learns why
    await k.app
      .get(TransactionHost)
      .run(() => k.app.get(DialInMachines).revokeActive(d.deviceId, "deleted"));
    const deleted = await second.closed;
    expect(deleted.code).toBe(DEVICE_CLOSE.revoked);
    expect(deleted.reason).toBe("the device was deleted");
    expect(second.stops).toEqual(["stop"]);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "deleted" ? true : null));
  });
  it("onClose receives replaced when the device signs in from another machine", async () => {
    const d = await device();
    const first = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // a second sign-in into the same device: a new machine credential, the first one revoked
    const second = await k.app.get(TransactionHost).run(() =>
      k.app.get(DialInMachines).issue({
        orgId,
        deviceId: d.deviceId,
        accountId: ownerId,
        name: "other",
        os: "linux",
        arch: "x64",
        programVersion: "0.0.0",
      }),
    );
    expect((await first.closed).code).toBe(DEVICE_CLOSE.replaced);
    // no stop reaches the replaced machine (it could reach the replacement instead)
    expect(first.stops).toEqual([]);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "replaced" ? true : null));
    const next = await FakeDialInMachine.connect({
      url,
      credential: second.credential,
      hello: { revision: "r2" },
    });
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(true);
    await next.close();
  });

  it("closes 4400 when a machine has more events in flight than the gateway keeps", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // the provider never finishes the first event: the rest wait, up to the cap
    await machine.send({ hang: true });
    for (let i = 0; i < MAX_EVENTS_IN_FLIGHT; i++) {
      if ((await Promise.race([machine.closed, Promise.resolve(null)])) !== null) break;
      await machine.send({ revision: `r${i}` }).catch(() => {});
    }
    const closed = await machine.closed;
    expect(closed.code).toBe(DEVICE_CLOSE.protocol);
    expect(closed.reason).toContain("too many events in flight");
  });
});

describe("ctx.dialIn", () => {
  it("ctx.dialIn.request relays a body and resolves the machine's res body", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    machine.onRequest((body) =>
      (body as { op?: string }).op === "stat" ? { size: 7, isDir: false } : null,
    );
    expect(await provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(10_000))).toEqual({
      size: 7,
      isDir: false,
    });
    expect(machine.requests).toEqual([{ op: "stat", args: { path: "/w/a" } }]);
    await machine.close();
  });

  it("ctx.dialIn.request throws DeviceOfflineError after the reconnect grace with no holder", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // the machine takes the request and goes away without answering
    machine.onRequest(() => new Promise(() => {}));
    const t0 = Date.now();
    const pending = rejection(
      provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(60_000)),
    );
    await waitFor(async () => (machine.requests.length > 0 ? true : null));
    await machine.close();
    const e = await pending;
    expect(isDeviceOfflineError(e)).toBe(true);
    // one lease check (at most a poll) plus the grace, far from the request's own deadline
    expect(Date.now() - t0).toBeLessThan(5000 + GRACE_SECONDS * 1000 + 5000);
  });

  it("ctx.dialIn.request for its own device is refused while the provider is off in the org", async () => {
    const d = await device();
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE plugin = 'fake-dial-in' AND org_id = ${orgId}`.execute(raw);
    try {
      const e = await rejection(
        provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(10_000)),
      );
      expect(e).toBeInstanceOf(ExtensionPermissionError);
      expect((e as Error).message).toBe(`device ${d.deviceId} is not served by fake-dial-in`);
    } finally {
      await enableExtensions(raw, orgId, "fake-dial-in");
    }
  });

  it("ctx.dialIn.request for a device of another provider throws ExtensionPermissionError", async () => {
    const other = await device("@local");
    const e = await rejection(
      provider().stat({ id: other.deviceId }, "/w/a", AbortSignal.timeout(10_000)),
    );
    expect(e).toBeInstanceOf(ExtensionPermissionError);
    expect((e as Error).message).toBe(`device ${other.deviceId} is not served by fake-dial-in`);
    expect(await redis.exists(`capk:device-req:${other.deviceId}`)).toBe(0);
  });
});
