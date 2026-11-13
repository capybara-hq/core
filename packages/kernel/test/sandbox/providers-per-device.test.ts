import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_EXTENSION_POINT, type SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { ExtensionRegistry } from "../../src/extensions/registry.js";
import {
  LOCAL_PROVIDER,
  type SandboxProviderEntry,
  SandboxProviders,
} from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox, readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";

/**
 * The sandbox provider is resolved per device (environments spec §6): a local device
 * runs on the kernel-internal `@local` provider, a cloud one on the loaded `sandbox@2` extension.
 * The sweeps only ever touch cloud devices.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
/** The cloud provider's directory (`sandbox-docker` in these tests). */
let cloudRoot: string;
/** The device provider's directory (`@local`). */
let deviceRoot: string;
let cloud: SandboxProviderEntry;
let local: SandboxProviderEntry;
let orgId: string;
let accountId: string;
let conversationId: string;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const later = (ms: number) => new Date(Date.now() + ms);
const signal = () => AbortSignal.timeout(30_000);
const log = { info() {}, warn() {}, error() {} };

/** A service whose cloud provider is `cloudEntry` and whose internal providers are `internal`. */
const service = (
  cloudEntry: SandboxProviderEntry | undefined,
  internal: SandboxProviderEntry[] = [local],
): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => cloudEntry,
    internal,
    config: () => config,
    log,
    lockPollMs: 20,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
});

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  for (const r of [cloudRoot, deviceRoot]) if (r) await rm(r, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  for (const r of [cloudRoot, deviceRoot]) if (r) await rm(r, { recursive: true, force: true });
  cloudRoot = await mkdtemp(join(tmpdir(), "cap-cloud-"));
  deviceRoot = await mkdtemp(join(tmpdir(), "cap-device-"));
  cloud = { plugin: "sandbox-docker", impl: createFakeSandbox(cloudRoot) };
  local = { plugin: LOCAL_PROVIDER, impl: createFakeSandbox(deviceRoot) };
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  accountId = randomUUID();
  orgId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  const agentId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  conversationId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
});

const seedLocal = () => seedDevice(raw, orgId, accountId, "local");
const seedCloud = () => seedDevice(raw, orgId, accountId);

const at = (deviceId: string) => ({
  orgId,
  deviceId,
  holderConversationId: conversationId,
  actor: { accountId, conversationId },
});

/** Runs `echo` in the device; returns the instance handle id. */
const run = (s: SandboxService, deviceId: string) =>
  s.withSandbox(
    at(deviceId),
    async (h, p, _i, sig) => {
      const r = await p.exec(h, {
        command: "echo hi",
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
        signal: sig,
      });
      expect(r.stdout.trim()).toBe("hi");
      return h.id;
    },
    signal(),
  );

const opsOf = async (root: string, op?: string) =>
  (await readFakeSandboxOps(root)).filter((o) => op === undefined || o[0] === op);

const instanceRow = (id: string) =>
  db.selectFrom("device_instances").selectAll().where("device_id", "=", id).executeTakeFirst();

describe("SandboxProviders", () => {
  const registry = (entries: { plugin: string; impl: SandboxProvider }[]) =>
    ({
      list: () => entries.map((e) => ({ ...e, capability: SANDBOX_EXTENSION_POINT })),
    }) as unknown as Pick<ExtensionRegistry, "list">;

  it("cloud() is the loaded extension only; forName finds internal providers first, then extensions", () => {
    const ext = createFakeSandbox(cloudRoot);
    const internal = createFakeSandbox(deviceRoot);
    const p = new SandboxProviders(registry([{ plugin: "sandbox-docker", impl: ext }]));
    // an extension is handed out guarded (connection failures become unreachable errors)
    expect(p.cloud()?.plugin).toBe("sandbox-docker");
    expect(p.cloud()?.impl).not.toBe(ext);
    expect(p.forName(LOCAL_PROVIDER)).toBeUndefined();
    p.register({ plugin: LOCAL_PROVIDER, impl: internal });
    // an internal provider is handed out as registered (not guarded)
    expect(p.forName(LOCAL_PROVIDER)).toEqual({ plugin: LOCAL_PROVIDER, impl: internal });
    expect(p.forName(LOCAL_PROVIDER)?.impl).toBe(internal);
    expect(p.forName("sandbox-docker")?.plugin).toBe("sandbox-docker");
    expect(p.forName("sandbox-e2b")).toBeUndefined();
    // an internal provider is never the cloud provider
    expect(new SandboxProviders(registry([])).cloud()).toBeUndefined();
  });
});

describe("provider per device", () => {
  it("a device on @local resolves the device provider while the cloud provider is docker", async () => {
    const s = service(cloud);
    const dev = await seedLocal();
    const cl = await seedCloud();
    await run(s, dev);
    expect(await opsOf(deviceRoot, "create")).toHaveLength(1);
    expect(await opsOf(cloudRoot)).toEqual([]);
    expect(await instanceRow(dev)).toMatchObject({ provider: LOCAL_PROVIDER, status: "running" });
    // a cloud device in the same org still uses the cloud provider
    await run(s, cl);
    expect(await opsOf(cloudRoot, "create")).toHaveLength(1);
    expect(await opsOf(deviceRoot, "create")).toHaveLength(1);
    expect(await instanceRow(cl)).toMatchObject({ provider: "sandbox-docker" });
  });

  it("ifRunning, resetFileSystem and destroyDevice use the device's provider", async () => {
    const s = service(cloud);
    const dev = await seedLocal();
    await run(s, dev);
    const inst = await s.currentInstance(dev);
    expect(inst).not.toBeNull();
    const r = await s.ifRunning(dev, inst as { createdAt: Date }, async () => "ok");
    expect(r).toEqual({ kind: "ran", value: "ok" });
    await s.resetFileSystem(dev);
    expect(await opsOf(deviceRoot, "destroy-fs")).toHaveLength(1);
    await run(s, dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    await s.destroyDevice(dev);
    expect(await instanceRow(dev)).toBeUndefined();
    expect(await opsOf(cloudRoot)).toEqual([]);
  });

  it("an idle local device is never suspended or destroyed", async () => {
    const s = service(cloud);
    const dev = await seedLocal();
    await run(s, dev);
    const before = await opsOf(deviceRoot);
    expect(await s.suspendIdle(later(DAY))).toBe(0);
    expect(await s.destroyInactive(later(365 * DAY))).toBe(0);
    // no cloud provider at all: the same
    expect(await service(undefined).destroyInactive(later(365 * DAY))).toBe(0);
    expect(await opsOf(deviceRoot)).toEqual(before);
    expect(await instanceRow(dev)).toMatchObject({ status: "running" });
  });

  it("a deleted org's local device instance is cleaned by the gone-sweep", async () => {
    const dev = await seedLocal();
    await run(service(cloud), dev);
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${orgId}`.execute(raw);
    // without a cloud provider too: the device provider alone serves the sweep
    expect(await service(undefined).destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
    expect(await opsOf(deviceRoot, "destroy")).toHaveLength(1);
    expect(await opsOf(deviceRoot, "destroy-fs")).toHaveLength(1);
    expect(await opsOf(cloudRoot)).toEqual([]);
  });

  it("a deleted local device is cleaned by the gone-sweep; not while @local is missing", async () => {
    const dev = await seedLocal();
    await run(service(cloud), dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    expect(await service(cloud, []).destroyInactive(new Date())).toBe(0);
    expect(await instanceRow(dev)).toBeDefined();
    expect(await service(cloud).destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
  });

  it("destroyDevice without the provider leaves the row for the sweep", async () => {
    const dev = await seedLocal();
    await run(service(cloud), dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    await expect(service(cloud, []).destroyDevice(dev)).rejects.toThrow(
      /sandbox provider is not there/,
    );
    expect((await instanceRow(dev))?.sweep_failed_at).toBeInstanceOf(Date);
    expect(await opsOf(deviceRoot, "destroy")).toEqual([]);
    // the provider is back: the sweep finishes it
    expect(await service(cloud).destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
  });

  it("a local device stays available when no cloud provider is loaded", async () => {
    const s = service(undefined);
    const dev = await seedLocal();
    const cl = await seedCloud();
    expect(s.cloudAvailable).toBe(false);
    expect(await s.availableFor(dev)).toBe(true);
    expect(await s.availableFor(cl)).toBe(false);
    await run(s, dev);
    const err = await run(s, cl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
  });

  it("a local device is unavailable while @local is not registered", async () => {
    const s = service(cloud, []);
    const dev = await seedLocal();
    expect(s.cloudAvailable).toBe(true);
    expect(await s.availableFor(dev)).toBe(false);
    const err = await run(s, dev).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
    // never falls back to the cloud provider
    expect(await opsOf(cloudRoot)).toEqual([]);
  });
});
