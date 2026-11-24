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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const service = (): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    providers: () => [
      { plugin: "device-fake", version: "1.0.0", impl: provider },
      { plugin: "device-fake-b", version: "1.0.0", impl: providerB },
    ],
    config: () => config,
    log: {},
    lockPollMs: 20,
  });

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
      if (r.handle) await provider.destroy(r.handle as { id: string }, signal());
    await rm(root, { recursive: true, force: true });
  }
  if (rootB) await rm(rootB, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-device-services-"));
  rootB = await mkdtemp(join(tmpdir(), "cap-device-services-b-"));
  provider = createFakeSandbox(root);
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
});

describe("stream holds", () => {
  it("idle suspension skips a device held for a stream", async () => {
    await services.ensure(use(), spec(), signal());
    const hold = await svc.holdForStream(deviceId, signal());
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(0);
    await hold.release();
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
  });

  it("another replica's idle suspension and destruction skip a held device", async () => {
    await services.ensure(use(), spec(), signal());
    const hold = await svc.holdForStream(deviceId, signal());
    // a second service over the same Redis and database: another replica's sweeps
    const other = service();
    expect(await other.suspendIdle(new Date(Date.now() + DAY))).toBe(0);
    expect(await other.destroyInactive(new Date(Date.now() + 30 * DAY))).toBe(0);
    await hold.release();
    expect(await other.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
  });

  it("an aborted signal releases the hold", async () => {
    await services.ensure(use(), spec(), signal());
    const ctl = new AbortController();
    const hold = await svc.holdForStream(deviceId, ctl.signal);
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(0);
    ctl.abort();
    expect(hold.signal.aborted).toBe(true);
    // release after the abort is the same release (idempotent) and resolves once it is done
    await hold.release();
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
  });

  it("a hold opens a stream to the service", async () => {
    await services.ensure(use(), spec(), signal());
    const hold = await svc.holdForStream(deviceId, signal());
    try {
      if (!hold.p.openStream) throw new Error("no openStream");
      const stream = await hold.p.openStream(hold.h, { service: "echo" }, signal());
      const it = stream.messages[Symbol.asyncIterator]();
      await stream.send(text("one"));
      expect(new TextDecoder().decode((await it.next()).value as Uint8Array)).toBe("one");
      await stream.send(text("two"));
      expect(new TextDecoder().decode((await it.next()).value as Uint8Array)).toBe("two");
      stream.close("done");
      expect((await stream.closed).reason).toBe("done");
    } finally {
      await hold.release();
    }
  });

  it("suspend kills the service", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    expect(await fakeServiceRunning(root, id, "echo")).toBe(true);
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    expect(await fakeServiceRunning(root, id, "echo")).toBe(false);
    // the next ensure resumes the instance and starts the service again
    const again = await services.ensure(use(), spec(), signal());
    expect(again.state).toBe("running");
    expect(await fakeServiceStarts(root)).toBe(2);
  });

  it("holdForStream refuses a suspended instance", async () => {
    await services.ensure(use(), spec(), signal());
    const id = await instanceId();
    expect(await svc.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    const err = await svc.holdForStream(deviceId, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as DeviceAccessError).code).toBe("provider_unavailable");
    // never resumed
    expect(await fakeSandboxState(root, id)).toBe("suspended");
    expect((await row())?.status).toBe("suspended");
  });

  it("holdForStream refuses a device with no instance", async () => {
    const err = await svc.holdForStream(deviceId, signal()).catch((e: unknown) => e);
    expect((err as DeviceAccessError).code).toBe("provider_unavailable");
    expect(await row()).toBeUndefined();
  });
});
