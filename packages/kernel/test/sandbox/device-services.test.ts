import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceAccessError,
  type DeviceProvider,
  type DeviceServiceSpec,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import { SandboxLockLostError } from "../../src/sandbox/leases.js";
import { LoopbackLivePorts } from "../../src/sandbox/loopback-live-ports.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import {
  createFakeSandbox,
  fakeSandboxMeta,
  fakeSandboxState,
  fakeServiceRunning,
  fakeServiceStarts,
  fakeServiceStateDir,
  fakeWorkspaceDir,
  holdNextFakeSandboxUpdate,
  readFakeSandboxLimits,
  readFakeSandboxOps,
  readFakeServiceLoopbackPorts,
  releaseFakeSandboxUpdate,
} from "../fixtures/plugins/device-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Device services (browser use spec §5): one long-lived named process per device with its own
 * state directory, started and reached through the kernel's `DeviceServices`, and the stream hold
 * (`SandboxService.holdForStream`) that keeps a device from idling while a viewer is open.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let rootB: string;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let deviceId: string;
let provider: DeviceProvider;
let providerB: DeviceProvider;
let echo: Uint8Array;

const signal = () => AbortSignal.timeout(30_000);
const DAY = 24 * 3600_000;
const text = (s: string) => new TextEncoder().encode(s);

/** The providers on in the org (both unless a test switches device-fake off). */
let onInOrg: string[];

/**
 * A short lease TTL (renewals every 500 ms), so a hold notices that it must yield within about
 * half a second; the tests wait for its signal, never for a fixed time.
 */
const service = (): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    providers: () => [
      { plugin: "device-fake", version: "1.0.0", impl: provider },
      { plugin: "device-fake-b", version: "1.0.0", impl: providerB },
    ],
    onInOrg: () => onInOrg,
    config: () => config,
    log: {},
    lockPollMs: 20,
    lockTtlMs: 1_500,
  });

/** Resolves once `s` aborts. */
const aborted = (s: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (s.aborted) resolve();
    else s.addEventListener("abort", () => resolve(), { once: true });
  });

const MIN = 60_000;

const spec = (): DeviceServiceSpec => ({
  name: "fake-ext.echo",
  runtime: "node",
  entry: "echo.mjs",
  args: [],
  files: { "echo.mjs": echo, "data/note.txt": text("note") },
});

const use = (device = deviceId): SandboxUseContext => ({
  orgId: seed.orgId,
  deviceId: device,
  holderConversationId: seed.conversationId,
  actor: { accountId: seed.accountId, conversationId: seed.conversationId },
});

const row = (device = deviceId) =>
  db.selectFrom("device_instances").selectAll().where("device_id", "=", device).executeTakeFirst();

const instanceId = async (): Promise<string> => {
  const r = await row();
  if (!r?.handle) throw new Error("no instance");
  return (r.handle as { id: string }).id;
};

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
  echo = new Uint8Array(
    await readFile(
      fileURLToPath(new URL("../fixtures/services/echo-service.mjs", import.meta.url)),
    ),
  );
});

let svc: SandboxService;
let services: DeviceServices;
let locks: LockService;

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
  if (rootB) await rm(rootB, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  // stop the services an earlier test left running (destroy kills them), then drop the roots
  if (root) {
    for (const r of await db.selectFrom("device_instances").selectAll().execute())
      if (r.handle) await provider.destroy(r.handle as { id: string }, signal(), null);
    await rm(root, { recursive: true, force: true });
  }
  if (rootB) await rm(rootB, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-device-services-"));
  rootB = await mkdtemp(join(tmpdir(), "cap-device-services-b-"));
  provider = createFakeSandbox(root, { updateMode: "updated" });
  onInOrg = ["device-fake", "device-fake-b"];
  providerB = createFakeSandbox(rootB, { services: false });
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  seed = await seedConversation(raw);
  deviceId = await seedDevice(raw, seed.orgId, seed.accountId);
  svc = service();
  // the live loopback ports read straight from the test's schema view (no transaction context)
  const kdb = Object.create(KernelDb.prototype, { db: { value: db } }) as KernelDb;
  locks = new LockService(redis, createLogger("error"));
  services = new DeviceServices(svc, new LoopbackLivePorts(kdb), locks);
});

describe("device services", () => {
  it("ensure starts the echo service once", async () => {
    const first = await services.ensure(use(), spec(), signal());
    const second = await services.ensure(use(), spec(), signal());
    expect(first.state).toBe("running");
    expect(first.name).toBe("fake-ext.echo");
    expect(second).toEqual(first);
    expect(await fakeServiceStarts(root)).toBe(1);
  });

  it("request round-trips through the service socket", async () => {
    await services.ensure(use(), spec(), signal());
    const answer = await services.request(use(), "fake-ext.echo", text("ping"), 5_000, signal());
    expect(new TextDecoder().decode(answer)).toBe("ping");
  });

  it("files are written into the service state dir, not the project root", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    const state = fakeServiceStateDir(root, id, "fake-ext.echo");
    expect(await readFile(join(state, "data/note.txt"), "utf8")).toBe("note");
    expect(existsSync(join(state, "echo.mjs"))).toBe(true);
    // the service itself wrote into the directory its environment named
    expect(existsSync(join(state, "started"))).toBe(true);
    const workspace = fakeWorkspaceDir(root, id);
    expect(state.startsWith(`${workspace}/`)).toBe(false);
    expect(existsSync(join(workspace, "echo.mjs"))).toBe(false);
  });

  it("provider without ensureService throws capability_missing", async () => {
    const other = await seedDevice(raw, seed.orgId, seed.accountId, "device-fake-b");
    const err = await services.ensure(use(other), spec(), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as DeviceAccessError).code).toBe("capability_missing");
    // refused before any instance was made for it
    expect(await row(other)).toBeUndefined();
  });

  it("stop ends the service and never resumes a suspended instance", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    await services.stop(use(), "fake-ext.echo", signal());
    expect(await fakeServiceRunning(root, id, "fake-ext.echo")).toBe(false);
    await expect(
      services.request(use(), "fake-ext.echo", text("ping"), 5_000, signal()),
    ).rejects.toThrow(/not running/);
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    await services.stop(use(), "fake-ext.echo", signal());
    expect(await fakeSandboxState(root, id)).toBe("suspended");
  });

  it("an invalid service name is refused before the device is used", async () => {
    await expect(services.ensure(use(), { ...spec(), name: "Bad Name" }, signal())).rejects.toThrow(
      /service id/,
    );
    expect(await row()).toBeUndefined();
  });

  it("a bare service name without its extension is refused before the device is used", async () => {
    await expect(services.ensure(use(), { ...spec(), name: "echo" }, signal())).rejects.toThrow(
      /service id/,
    );
    await expect(services.request(use(), "echo", text("ping"), 5_000, signal())).rejects.toThrow(
      /service id/,
    );
    expect(await row()).toBeUndefined();
  });

  it("a spec whose files or env would change what runs is refused before the device is used", async () => {
    const bad: [Partial<DeviceServiceSpec>, RegExp][] = [
      [{ files: { ...spec().files, "../escape.mjs": text("x") } }, /"\.\." segment/],
      [{ files: { ...spec().files, "/abs.mjs": text("x") } }, /is absolute/],
      [{ files: { ...spec().files, "a\\b.mjs": text("x") } }, /backslash/],
      [{ files: { ...spec().files, "a\0b": text("x") } }, /NUL/],
      [{ entry: "../echo.mjs" }, /"\.\." segment/],
      [{ entry: "missing.mjs" }, /not one of the files/],
      [{ env: { NODE_OPTIONS: "--require /tmp/x.js" } }, /NODE_OPTIONS may not be set/],
      [{ env: { LD_PRELOAD: "/tmp/x.so" } }, /LD_PRELOAD may not be set/],
      [{ env: { DYLD_INSERT_LIBRARIES: "/tmp/x" } }, /may not be set/],
      [{ env: { CAPYBARA_SERVICE_SOCKET: "/tmp/s" } }, /may not be set/],
      [{ env: { https_proxy: "http://evil" } }, /may not be set/],
      [{ env: { PATH: "/tmp/evil:/usr/bin" } }, /PATH may not be set/],
      [{ env: { NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" } }, /NODE_EXTRA_CA_CERTS may not be set/],
      [{ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }, /may not be set/],
      [{ env: { SSL_CERT_FILE: "/tmp/ca.pem" } }, /SSL_CERT_FILE may not be set/],
      [{ env: { SSL_CERT_DIR: "/tmp/ca" } }, /SSL_CERT_DIR may not be set/],
      [{ env: { OPENSSL_CONF: "/tmp/openssl.cnf" } }, /OPENSSL_CONF may not be set/],
      [{ env: { openssl_engines: "/tmp/engines" } }, /openssl_engines may not be set/],
    ];
    for (const [over, message] of bad) {
      await expect(services.ensure(use(), { ...spec(), ...over }, signal())).rejects.toThrow(
        message,
      );
    }
    expect(await row()).toBeUndefined();
  });

  it("an ifRunning ensure never starts a stopped service and keeps a running one", async () => {
    const stopped = await services.ensure(use(), spec(), signal(), { ifRunning: true });
    expect(stopped).toMatchObject({ name: "fake-ext.echo", state: "stopped", startedAt: null });
    // the provider's state directory (the fake's sits in the device's files: `.svc/<name>`)
    expect(stopped.stateDir).toMatch(/\/\.svc\/fake-ext\.echo$/);
    const want = fakeServiceStateDir(root, await instanceId(), "fake-ext.echo");
    expect(stopped.stateDir.endsWith(want.slice(root.length))).toBe(true);
    expect(await fakeServiceStarts(root)).toBe(0);
    const started = await services.ensure(use(), spec(), signal());
    expect(await services.ensure(use(), spec(), signal(), { ifRunning: true })).toEqual(started);
    expect(await services.refresh(use(), "fake-ext.echo", signal())).toEqual(started);
    expect(await fakeServiceStarts(root)).toBe(1);
  });

  it("every ifRunning ensure sends the provider the name-only spec", async () => {
    const seen: { spec: DeviceServiceSpec; ifRunning: boolean }[] = [];
    const ensure = provider.ensureService?.bind(provider);
    if (!ensure) throw new Error("device-fake has services");
    provider.ensureService = async (h, spec, sig, opts) => {
      seen.push({ spec, ifRunning: opts?.ifRunning === true });
      return ensure(h, spec, sig, opts);
    };
    const nameOnly = { name: "fake-ext.echo", runtime: "node", entry: "", args: [], files: {} };
    await services.ensure(use(), spec(), signal(), { ifRunning: true });
    await services.ensure(use(), spec(), signal());
    await services.refresh(use(), "fake-ext.echo", signal());
    // refresh of a running service with nothing to apply: one ifRunning ensure
    expect(seen.map((c) => c.ifRunning)).toEqual([true, false, true]);
    expect(seen[0]?.spec).toEqual(nameOnly);
    expect(seen[1]?.spec).toEqual(spec());
    expect(seen[2]?.spec).toEqual(nameOnly);
  });

  it("sends the live set with every ensure", async () => {
    const grant = async (port: number, over: { expired?: boolean; revoked?: boolean } = {}) =>
      sql`INSERT INTO capybara.device_loopback_grants
        (id, org_id, device_id, service_id, conversation_id, port, source, expires_at,
         revoked_at, revoke_reason)
        VALUES (${randomUUID()}, ${seed.orgId}, ${deviceId}, 'fake-ext.echo', ${seed.conversationId},
          ${port}, 'owner-panel',
          ${over.expired ? sql`now() - interval '1 second'` : sql`now() + interval '1 hour'`},
          ${over.revoked ? sql`now()` : null}, ${over.revoked ? "revoked" : null})`.execute(raw);
    await services.ensure(use(), spec(), signal());
    await grant(3999);
    // neither an expired nor a revoked grant is live
    await grant(4000, { expired: true });
    await grant(4001, { revoked: true });
    await services.ensure(use(), spec(), signal());
    await services.ensure(use(), spec(), signal(), { ifRunning: true });
    await grant(3000);
    expect(
      await services.refreshLoopback(seed.orgId, deviceId, "fake-ext.echo", signal()),
    ).toMatchObject({ state: "running" });
    await sql`UPDATE capybara.device_loopback_grants SET revoked_at = now(), revoke_reason = 'revoked'`.execute(
      raw,
    );
    await services.refresh(use(), "fake-ext.echo", signal());
    expect(await readFakeServiceLoopbackPorts(root)).toEqual([
      [],
      [3999],
      [3999],
      [3000, 3999],
      [],
    ]);
    // the refresh of a loopback change applies no limits (no update of the instance)
    expect((await readFakeSandboxOps(root)).filter((o) => o[0] === "update")).toEqual([]);
  });

  it("a send of an older set never reaches the device after a newer one", async () => {
    await services.ensure(use(), spec(), signal());
    await sql`INSERT INTO capybara.device_loopback_grants
      (id, org_id, device_id, service_id, conversation_id, port, source, expires_at)
      VALUES (${randomUUID()}, ${seed.orgId}, ${deviceId}, 'fake-ext.echo', ${seed.conversationId},
        3999, 'owner-panel', now() + interval '1 hour')`.execute(raw);
    // the grant's refresh reads {3999} and its send is held at the device
    const ensure = provider.ensureService?.bind(provider);
    if (!ensure) throw new Error("device-fake has services");
    const done: number[][] = [];
    let entered!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    provider.ensureService = async (h, sp, sig, opts) => {
      const ports = [...(opts?.loopbackPorts ?? [])];
      if (first) {
        first = false;
        entered();
        await gate;
      }
      const r = await ensure(h, sp, sig, opts);
      done.push(ports);
      return r;
    };
    const grantSend = services.refreshLoopback(seed.orgId, deviceId, "fake-ext.echo", signal());
    await held;
    // the revoke commits, and its refresh waits for the set lock the grant's send holds
    await sql`UPDATE capybara.device_loopback_grants SET revoked_at = now(), revoke_reason = 'revoked'`.execute(
      raw,
    );
    const waiting = new Promise<void>((resolve) => {
      const acquire = locks.acquire.bind(locks);
      vi.spyOn(locks, "acquire").mockImplementation(async (key, o) => {
        resolve();
        return acquire(key, o);
      });
    });
    const revokeSend = services.refreshLoopback(seed.orgId, deviceId, "fake-ext.echo", signal());
    await waiting;
    release();
    await Promise.all([grantSend, revokeSend]);
    // the newer set (read after the older send finished) lands last
    expect(done).toEqual([[3999], []]);
  });
});

/**
 * The device's allowlist changed outside a tool call (the panel's allow): `refresh` applies the
 * new limits to the running instance under the exclusive lease, as a use would, before its
 * `ifRunning` ensure, and never resumes or starts anything.
 */
describe("refresh after an allowlist change", () => {
  const setHosts = (extraHosts: string[]) =>
    sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts },
    })}::jsonb WHERE id = ${seed.orgId}`.execute(raw);
  const updates = async () => (await readFakeSandboxOps(root)).filter((o) => o[0] === "update");
  const lastLimits = async () => (await readFakeSandboxLimits(root)).at(-1);
  const hold = () => svc.holdForStream(deviceId, seed.orgId, signal());

  it("applies a widened allowlist to the running instance; the service keeps running and viewers yield", async () => {
    await setHosts([]);
    const started = await services.ensure(use(), spec(), signal());
    const h = await hold();
    await setHosts(["example.com"]);
    expect(await services.refresh(use(), "fake-ext.echo", signal())).toEqual(started);
    expect(await updates()).toHaveLength(1);
    const applied = await lastLimits();
    expect(applied?.op).toBe("update");
    expect(applied?.limits.network.hosts).toContain("example.com");
    // fenced as a use's update is: it carries the holder's token
    expect(applied?.fence).toEqual(expect.any(Number));
    expect(await fakeServiceStarts(root)).toBe(1);
    // the exclusive lease ended the stream hold (ruling R7): the panel reconnects
    await aborted(h.signal);
    await h.release();
    // applied: the next refresh and the next use change nothing
    await services.refresh(use(), "fake-ext.echo", signal());
    await services.request(use(), "fake-ext.echo", text("ping"), 5_000, signal());
    expect(await updates()).toHaveLength(1);
  });

  it("limits that already apply take no lease: an open viewer stays", async () => {
    await setHosts(["example.com"]);
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    await services.refresh(use(), "fake-ext.echo", signal());
    expect(await updates()).toHaveLength(0);
    expect(h.signal.aborted).toBe(false);
    await h.release();
  });

  it("a suspended instance is not resumed: the next use applies the limits", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    await setHosts(["example.com"]);
    expect(await services.refresh(use(), "fake-ext.echo", signal())).toBeNull();
    expect(await fakeSandboxState(root, id)).toBe("suspended");
    expect(await updates()).toHaveLength(0);
    expect((await readFakeSandboxOps(root)).some((o) => o[0] === "resume")).toBe(false);
    await services.ensure(use(), spec(), signal());
    expect(await updates()).toHaveLength(1);
  });

  it("a provider without update recreates the instance on the kept files: the service ends with it", async () => {
    provider = createFakeSandbox(root);
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const before = await instanceId();
    await setHosts(["example.com"]);
    const status = await services.refresh(use(), "fake-ext.echo", signal());
    // the ifRunning ensure on the new instance finds the service stopped and starts nothing
    expect(status?.state).toBe("stopped");
    const after = await instanceId();
    expect(after).not.toBe(before);
    expect(await fakeServiceRunning(root, before, "fake-ext.echo")).toBe(false);
    expect(await fakeServiceStarts(root)).toBe(1);
    const applied = await lastLimits();
    expect(applied?.op).toBe("create");
    expect(applied?.limits.network.hosts).toContain("example.com");
    expect((await row())?.status).toBe("running");
  });

  it("a use holding the device on another replica keeps it: refresh waits for it, then applies", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    await setHosts(["example.com"]);
    // another replica's holder (its own SandboxService on the same Postgres and Redis)
    const other = service();
    const current = await other.currentInstance(deviceId);
    if (!current) throw new Error("no instance");
    let letGo = () => {};
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = other.ifRunning(deviceId, { createdAt: current.createdAt }, async () => {
      entered();
      await gate;
    });
    await inside;
    const refreshed = services.refresh(use(), "fake-ext.echo", signal());
    // the waiter's intent: new shared leases wait behind it
    await vi.waitFor(
      async () => expect(await redis.exists(`capk:sandbox-intent:${deviceId}`)).toBe(1),
      { timeout: 10_000, interval: 20 },
    );
    expect(await updates()).toHaveLength(0);
    letGo();
    expect((await held).kind).toBe("ran");
    expect((await refreshed)?.state).toBe("running");
    expect(await updates()).toHaveLength(1);
    expect(await fakeServiceStarts(root)).toBe(1);
  });

  /** Another replica's use holding the device's shared lease until `letGo()`. */
  const holdElsewhere = async () => {
    const other = service();
    const current = await other.currentInstance(deviceId);
    if (!current) throw new Error("no instance");
    let letGo = () => {};
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = other.ifRunning(deviceId, { createdAt: current.createdAt }, async () => {
      entered();
      await gate;
    });
    await inside;
    return { letGo, done };
  };
  const intentKey = () => `capk:sandbox-intent:${deviceId}`;
  const intentSet = () =>
    vi.waitFor(async () => expect(await redis.exists(intentKey())).toBe(1), {
      timeout: 10_000,
      interval: 20,
    });

  it("a stopped service needs nothing now: the instance is left as it is", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    await services.stop(use(), "fake-ext.echo", signal());
    const h = await hold();
    await setHosts(["example.com"]);
    expect((await services.refresh(use(), "fake-ext.echo", signal()))?.state).toBe("stopped");
    expect(await updates()).toHaveLength(0);
    expect(await instanceId()).toBe(id);
    expect(h.signal.aborted).toBe(false);
    await h.release();
    // the next use applies them
    await services.ensure(use(), spec(), signal());
    expect(await updates()).toHaveLength(1);
  });

  it("a use outlasting sandbox.lockWaitSeconds keeps the device: busy, intent cleared, no update", async () => {
    config = { ...config, sandbox: { ...config.sandbox, lockWaitSeconds: 0.3 } };
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    await setHosts(["example.com"]);
    const held = await holdElsewhere();
    await expect(services.refresh(use(), "fake-ext.echo", signal())).rejects.toMatchObject({
      code: "sandbox.busy",
    });
    expect(await redis.exists(intentKey())).toBe(0);
    expect(await updates()).toHaveLength(0);
    held.letGo();
    expect((await held.done).kind).toBe("ran");
    expect((await row())?.status).toBe("running");
  });

  it("an abort during the wait reaches no provider", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    await setHosts(["example.com"]);
    const held = await holdElsewhere();
    const ac = new AbortController();
    const refreshed = services.refresh(use(), "fake-ext.echo", ac.signal);
    await intentSet();
    ac.abort(new Error("caller gave up"));
    await expect(refreshed).rejects.toThrow(/caller gave up/);
    expect(await redis.exists(intentKey())).toBe(0);
    held.letGo();
    await held.done;
    expect(await updates()).toHaveLength(0);
    expect((await readFakeSandboxLimits(root)).filter((e) => e.op === "update")).toHaveLength(0);
    expect((await row())?.status).toBe("running");
  });

  it("the apply and the ensure after it have their own budget: a spent caller signal skips neither", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    await setHosts(["example.com"]);
    const signals: AbortSignal[] = [];
    const update = provider.update?.bind(provider);
    if (!update) throw new Error("device-fake updates");
    provider.update = async (h, limits, sig, fence) => {
      signals.push(sig);
      return update(h, limits, sig, fence);
    };
    await holdNextFakeSandboxUpdate(root, "panel");
    const ac = new AbortController();
    const refreshed = services.refresh(use(), "fake-ext.echo", ac.signal);
    await vi.waitFor(
      async () =>
        expect((await readFakeSandboxOps(root)).some((o) => o[0] === "update-held")).toBe(true),
      { timeout: 10_000, interval: 20 },
    );
    const ensuresBefore = (await readFakeSandboxOps(root)).filter(
      (o) => o[0] === "service-if-running",
    ).length;
    ac.abort(new Error("caller gave up"));
    expect(signals[0]?.aborted).toBe(false);
    await releaseFakeSandboxUpdate(root, "panel");
    // the update completes and is recorded, and the ifRunning ensure after it runs on its own
    // budget although the caller's signal is spent (a provider restarts the service there)
    expect((await refreshed)?.state).toBe("running");
    const ensuresAfter = (await readFakeSandboxOps(root)).filter(
      (o) => o[0] === "service-if-running",
    ).length;
    expect(ensuresAfter).toBe(ensuresBefore + 1);
    expect(await updates()).toHaveLength(1);
    expect((await row())?.status).toBe("running");
    const id = await instanceId();
    expect((await fakeSandboxMeta(root, id))?.limits.network.hosts).toContain("example.com");
    expect(await fakeSandboxState(root, id)).toBe("running");
  });

  it("an update refused as stale loses the lease and recreates nothing", async () => {
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    // a newer holder's token at the provider, ahead of the device record
    const meta = await fakeSandboxMeta(root, id);
    await writeFile(
      join(root, "instances", id, "meta.json"),
      JSON.stringify({ ...meta, fence: 1_000_000 }),
    );
    await setHosts(["example.com"]);
    await expect(services.refresh(use(), "fake-ext.echo", signal())).rejects.toBeInstanceOf(
      SandboxLockLostError,
    );
    const ops = await readFakeSandboxOps(root);
    expect(ops.some((o) => o[0] === "stale-fence" && o[2] === "update")).toBe(true);
    expect(ops.some((o) => o[0] === "destroy")).toBe(false);
    expect((await readFakeSandboxLimits(root)).filter((e) => e.op === "create")).toHaveLength(1);
    expect(await instanceId()).toBe(id);
    expect(await fakeServiceRunning(root, id, "fake-ext.echo")).toBe(true);
  });

  it("a device deleted while the refresh waited gets nothing applied or recreated", async () => {
    provider = createFakeSandbox(root);
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    await setHosts(["example.com"]);
    const held = await holdElsewhere();
    const refreshed = services.refresh(use(), "fake-ext.echo", signal());
    await intentSet();
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${deviceId}`.execute(raw);
    held.letGo();
    await held.done;
    await refreshed;
    expect(await instanceId()).toBe(id);
    expect((await readFakeSandboxLimits(root)).filter((e) => e.op === "create")).toHaveLength(1);
    expect((await readFakeSandboxOps(root)).some((o) => o[0] === "destroy")).toBe(false);
  });
});

describe("stream holds", () => {
  const hold = (sig: AbortSignal = signal()) => svc.holdForStream(deviceId, seed.orgId, sig);
  // idle (past suspendAfterIdleMinutes) but not past maxRunningMinutes
  const idle = () => new Date(Date.now() + 30 * MIN);

  it("idle suspension skips a device held for a stream", async () => {
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    expect(await svc.suspendIdle(idle())).toBe(0);
    expect(h.signal.aborted).toBe(false);
    await h.release();
    expect(await svc.suspendIdle(idle())).toBe(1);
  });

  it("a hold taken while the sweep waits for the device is seen under its lease", async () => {
    await services.ensure(use(), spec(), signal());
    // the sweep reads no hold, then a viewer opens before the sweep takes the device's lease
    const leases = (svc as unknown as { leases: { streamHolds(id: string): Promise<number> } })
      .leases;
    const real = leases.streamHolds.bind(leases);
    let h: Awaited<ReturnType<typeof hold>> | undefined;
    vi.spyOn(leases, "streamHolds").mockImplementationOnce(async (id) => {
      const n = await real(id);
      h = await hold();
      return n;
    });
    expect(await svc.suspendIdle(idle())).toBe(0);
    expect((await row())?.status).toBe("running");
    expect(h?.signal.aborted).toBe(false);
    await h?.release();
    vi.restoreAllMocks();
    expect(await svc.suspendIdle(idle())).toBe(1);
  });

  it("another replica's idle suspension and destruction skip a held device", async () => {
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    // a second service over the same Redis and database: another replica's sweeps
    const other = service();
    expect(await other.suspendIdle(idle())).toBe(0);
    expect(await other.destroyInactive(new Date(Date.now() + 30 * DAY))).toBe(0);
    await h.release();
    expect(await other.suspendIdle(idle())).toBe(1);
  });

  it("the forced suspension after maxRunningMinutes proceeds with a hold open", async () => {
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    await aborted(h.signal);
    expect((await row())?.status).toBe("suspended");
    await h.release();
  });

  it("a hold yields to a limits change: its signal aborts and the change completes", async () => {
    const setHosts = (extraHosts: string[]) =>
      sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
        outsideSandbox: "off",
        deviceNetwork: { ceiling: "allowlist", extraHosts },
      })}::jsonb WHERE id = ${seed.orgId}`.execute(raw);
    await setHosts([]);
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    await setHosts(["example.com"]);
    // the next use applies the widened allowlist under the exclusive lease
    await services.request(use(), "fake-ext.echo", text("ping"), 5_000, signal());
    const ops = (await readFakeSandboxOps(root)).filter((o) => o[0] === "update");
    expect(ops).toHaveLength(1);
    await aborted(h.signal);
    await h.release();
  });

  it("a hold yields to destroyDevice: its signal aborts and the device is destroyed", async () => {
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    await svc.destroyDevice(deviceId);
    expect(await row()).toBeUndefined();
    await aborted(h.signal);
    await h.release();
  });

  it("holds take no command slot", async () => {
    config = KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rdc.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      sandbox: { maxConcurrentCommands: 1, lockWaitSeconds: 2 },
    });
    await services.ensure(use(), spec(), signal());
    const holds = [await hold(), await hold(), await hold()];
    // the one slot is free for commands while three viewers are open
    const answer = await services.request(use(), "fake-ext.echo", text("ping"), 5_000, signal());
    expect(new TextDecoder().decode(answer)).toBe("ping");
    for (const h of holds) expect(h.signal.aborted).toBe(false);
    for (const h of holds) await h.release();
  });

  it("an aborted signal releases the hold", async () => {
    await services.ensure(use(), spec(), signal());
    const ctl = new AbortController();
    const h = await hold(ctl.signal);
    expect(await svc.suspendIdle(idle())).toBe(0);
    ctl.abort();
    expect(h.signal.aborted).toBe(true);
    // release after the abort is the same release (idempotent) and resolves once it is done
    await h.release();
    expect(await svc.suspendIdle(idle())).toBe(1);
  });

  it("a hold opens a stream to the service", async () => {
    await services.ensure(use(), spec(), signal());
    const h = await hold();
    try {
      const stream = await h.p.openStream(h.h, { service: "fake-ext.echo" }, signal());
      const it = stream.messages[Symbol.asyncIterator]();
      await stream.send(text("one"));
      expect(new TextDecoder().decode((await it.next()).value as Uint8Array)).toBe("one");
      await stream.send(text("two"));
      expect(new TextDecoder().decode((await it.next()).value as Uint8Array)).toBe("two");
      stream.close("done");
      expect((await stream.closed).reason).toBe("done");
    } finally {
      await h.release();
    }
  });

  it("suspend kills the service", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    expect(await fakeServiceRunning(root, id, "fake-ext.echo")).toBe(true);
    expect(await svc.suspendIdle(idle())).toBe(1);
    expect(await fakeServiceRunning(root, id, "fake-ext.echo")).toBe(false);
    // the next ensure resumes the instance and starts the service again
    const again = await services.ensure(use(), spec(), signal());
    expect(again.state).toBe("running");
    expect(await fakeServiceStarts(root)).toBe(2);
  });

  it("holdForStream refuses a suspended instance", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    expect(await svc.suspendIdle(idle())).toBe(1);
    const err = await hold().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as DeviceAccessError).code).toBe("provider_unavailable");
    // never resumed
    expect(await fakeSandboxState(root, id)).toBe("suspended");
    expect((await row())?.status).toBe("suspended");
  });

  it("holdForStream refuses a device with no instance", async () => {
    const err = await hold().catch((e: unknown) => e);
    expect((err as DeviceAccessError).code).toBe("provider_unavailable");
    expect(await row()).toBeUndefined();
  });

  it("holdForStream refuses a device whose provider is off in the org", async () => {
    await services.ensure(use(), spec(), signal());
    onInOrg = ["device-fake-b"];
    const err = await hold().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as DeviceAccessError).code).toBe("provider_unavailable");
  });

  it("holdForStream refuses a provider without openStream", async () => {
    const other = await seedDevice(raw, seed.orgId, seed.accountId, "device-fake-b");
    const err = await svc.holdForStream(other, seed.orgId, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as DeviceAccessError).code).toBe("capability_missing");
  });
});
