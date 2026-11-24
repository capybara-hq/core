import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { DeviceServices } from "../../src/sandbox/device-services.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import {
  createFakeSandbox,
  fakeSandboxState,
  fakeServiceRunning,
  fakeServiceStarts,
  fakeServiceStateDir,
  fakeWorkspaceDir,
  readFakeSandboxOps,
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
  name: "echo",
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
  services = new DeviceServices(svc);
});

describe("device services", () => {
  it("ensure starts the echo service once", async () => {
    const first = await services.ensure(use(), spec(), signal());
    const second = await services.ensure(use(), spec(), signal());
    expect(first.state).toBe("running");
    expect(first.name).toBe("echo");
    expect(second).toEqual(first);
    expect(await fakeServiceStarts(root)).toBe(1);
  });

  it("request round-trips through the service socket", async () => {
    await services.ensure(use(), spec(), signal());
    const answer = await services.request(use(), "echo", text("ping"), 5_000, signal());
    expect(new TextDecoder().decode(answer)).toBe("ping");
  });

  it("files are written into the service state dir, not the project root", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    const state = fakeServiceStateDir(root, id, "echo");
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
    await services.stop(use(), "echo", signal());
    expect(await fakeServiceRunning(root, id, "echo")).toBe(false);
    await expect(services.request(use(), "echo", text("ping"), 5_000, signal())).rejects.toThrow(
      /not running/,
    );
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    await services.stop(use(), "echo", signal());
    expect(await fakeSandboxState(root, id)).toBe("suspended");
  });

  it("an invalid service name is refused before the device is used", async () => {
    await expect(services.ensure(use(), { ...spec(), name: "Bad Name" }, signal())).rejects.toThrow(
      /service name/,
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
    expect(stopped).toMatchObject({ name: "echo", state: "stopped", startedAt: null });
    // the provider's state directory (the fake's sits in the device's files: `.svc/<name>`)
    expect(stopped.stateDir).toMatch(/\/\.svc\/echo$/);
    const want = fakeServiceStateDir(root, await instanceId(), "echo");
    expect(stopped.stateDir.endsWith(want.slice(root.length))).toBe(true);
    expect(await fakeServiceStarts(root)).toBe(0);
    const started = await services.ensure(use(), spec(), signal());
    expect(await services.ensure(use(), spec(), signal(), { ifRunning: true })).toEqual(started);
    expect(await services.refresh(use(), "echo", signal())).toEqual(started);
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
    const nameOnly = { name: "echo", runtime: "node", entry: "", args: [], files: {} };
    await services.ensure(use(), spec(), signal(), { ifRunning: true });
    await services.ensure(use(), spec(), signal());
    await services.refresh(use(), "echo", signal());
    expect(seen.map((c) => c.ifRunning)).toEqual([true, false, true]);
    expect(seen[0]?.spec).toEqual(nameOnly);
    expect(seen[1]?.spec).toEqual(spec());
    expect(seen[2]?.spec).toEqual(nameOnly);
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
    await services.request(use(), "echo", text("ping"), 5_000, signal());
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
    const answer = await services.request(use(), "echo", text("ping"), 5_000, signal());
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
      const stream = await h.p.openStream(h.h, { service: "echo" }, signal());
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
    expect(await fakeServiceRunning(root, id, "echo")).toBe(true);
    expect(await svc.suspendIdle(idle())).toBe(1);
    expect(await fakeServiceRunning(root, id, "echo")).toBe(false);
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
