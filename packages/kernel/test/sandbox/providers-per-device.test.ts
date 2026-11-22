import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_PROVIDER_EXTENSION_POINT, type DeviceProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { ExtensionRegistry } from "../../src/extensions/registry.js";
import {
  type DeviceProviderEntry,
  DeviceProviders,
  LOCAL_PROVIDER,
} from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox, readFakeSandboxOps } from "../fixtures/plugins/device-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";

/**
 * A device is bound to its own provider for life (device-provider spec §6.1): each device runs on
 * the provider named by its `devices.provider` (two fake extensions, `device-fake` and
 * `device-fake-b`, side by side, and the kernel-internal `@local`), only while that provider is on
 * in the device's org; a device whose provider is off or not loaded is unavailable, its files and
 * instance kept, and nothing is created at another provider. The sweeps run per loaded provider
 * over its own rows only.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
/** `device-fake`'s directory. */
let rootA: string;
/** `device-fake-b`'s directory. */
let rootB: string;
/** The `@local` fake's directory. */
let localRoot: string;
let fakeA: DeviceProviderEntry;
let fakeB: DeviceProviderEntry;
let local: DeviceProviderEntry;
let orgId: string;
let accountId: string;
let conversationId: string;
/** The plugin names switched off per org (read at every use, as the catalog is). */
let off: Map<string, Set<string>>;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const later = (ms: number) => new Date(Date.now() + ms);
const signal = () => AbortSignal.timeout(30_000);
const log = { info() {}, warn() {}, error() {} };

/** A service with the loaded extensions `loaded` and the internal providers `internal`. */
const service = (
  loaded: () => DeviceProviderEntry[] = () => [fakeA, fakeB],
  internal: DeviceProviderEntry[] = [local],
): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    providers: loaded,
    internal,
    onInOrg: (org) =>
      loaded()
        .map((e) => e.plugin)
        .filter((p) => !off.get(org)?.has(p)),
    config: () => config,
    log,
    lockPollMs: 20,
  });

const disable = (org: string, plugin: string) => {
  off.set(org, new Set([...(off.get(org) ?? []), plugin]));
};
const enable = (org: string, plugin: string) => off.get(org)?.delete(plugin);

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
  for (const r of [rootA, rootB, localRoot]) if (r) await rm(r, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  for (const r of [rootA, rootB, localRoot]) if (r) await rm(r, { recursive: true, force: true });
  rootA = await mkdtemp(join(tmpdir(), "cap-device-a-"));
  rootB = await mkdtemp(join(tmpdir(), "cap-device-b-"));
  localRoot = await mkdtemp(join(tmpdir(), "cap-device-local-"));
  fakeA = { plugin: "device-fake", version: "1.0.0", impl: createFakeSandbox(rootA) };
  fakeB = { plugin: "device-fake-b", version: "1.0.0", impl: createFakeSandbox(rootB) };
  local = { plugin: LOCAL_PROVIDER, version: "1.0.0", impl: createFakeSandbox(localRoot) };
  off = new Map();
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

/** A new org with a member, an agent and a conversation; returns their ids. */
async function seedOrg(): Promise<{ orgId: string; accountId: string; conversationId: string }> {
  const account = randomUUID();
  const org = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${account}, 'U')`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${org}, ${`o-${org.slice(0, 8)}`}, 'O', ${account})`.execute(raw);
  const agentId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${org}, ${account}, 'org', 1)`.execute(raw);
  const conv = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conv}, ${org}, ${agentId}, ${account})`.execute(raw);
  return { orgId: org, accountId: account, conversationId: conv };
}

const seedLocal = () => seedDevice(raw, orgId, accountId, "local");
/** A cloud device bound to `provider` in `org` (default: this test's org). */
const seedCloud = async (provider = "device-fake", org = orgId, account = accountId) => {
  const id = await seedDevice(raw, org, account);
  await sql`UPDATE capybara.devices SET provider = ${provider} WHERE id = ${id}`.execute(raw);
  return id;
};

const at = (
  deviceId: string,
  o: { orgId: string; accountId: string; conversationId: string } = {
    orgId,
    accountId,
    conversationId,
  },
) => ({
  orgId: o.orgId,
  deviceId,
  holderConversationId: o.conversationId,
  actor: { accountId: o.accountId, conversationId: o.conversationId },
});

/** Runs `echo` in the device; returns the instance handle id. */
const run = (
  s: SandboxService,
  deviceId: string,
  o?: { orgId: string; accountId: string; conversationId: string },
) =>
  s.withSandbox(
    at(deviceId, o),
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

describe("DeviceProviders", () => {
  const registry = (entries: { plugin: string; impl: DeviceProvider }[]) =>
    ({
      list: () =>
        entries.map((e) => ({
          ...e,
          version: "0.1.0",
          capability: DEVICE_PROVIDER_EXTENSION_POINT,
        })),
    }) as unknown as Pick<ExtensionRegistry, "list">;

  it("forDevice finds internal providers first, then the extension of that name, never another; loaded lists the extensions", () => {
    const a = createFakeSandbox(rootA);
    const b = createFakeSandbox(rootB);
    const internal = createFakeSandbox(localRoot);
    const p = new DeviceProviders(
      registry([
        { plugin: "device-fake", impl: a },
        { plugin: "device-fake-b", impl: b },
      ]),
    );
    // an extension is handed out guarded (connection failures become unreachable errors)
    expect(p.forDevice("device-fake")?.plugin).toBe("device-fake");
    expect(p.forDevice("device-fake")?.impl).not.toBe(a);
    expect(p.forDevice("device-fake-b")?.plugin).toBe("device-fake-b");
    expect(p.forDevice("device-e2b")).toBeUndefined();
    expect(p.forDevice(null)).toBeUndefined();
    expect(p.forDevice(LOCAL_PROVIDER)).toBeUndefined();
    p.register({ plugin: LOCAL_PROVIDER, version: "1.0.0", impl: internal });
    // an internal provider is handed out as registered (not guarded) and is never in loaded()
    expect(p.forDevice(LOCAL_PROVIDER)?.impl).toBe(internal);
    expect(p.loaded().map((e) => e.plugin)).toEqual(["device-fake", "device-fake-b"]);
  });
});

describe("devices bound to their provider", () => {
  it("each device uses its own provider; both run in one org at once", async () => {
    const s = service();
    const a = await seedCloud("device-fake");
    const b = await seedCloud("device-fake-b");
    await Promise.all([run(s, a), run(s, b)]);
    expect(await opsOf(rootA, "create")).toHaveLength(1);
    expect(await opsOf(rootB, "create")).toHaveLength(1);
    expect(await instanceRow(a)).toMatchObject({ provider: "device-fake", status: "running" });
    expect(await instanceRow(b)).toMatchObject({ provider: "device-fake-b", status: "running" });
    expect(await s.availableFor(a, orgId)).toBe(true);
    expect(await s.availableFor(b, orgId)).toBe(true);
  });

  it("a provider switched off in the org: the device is unavailable, its row, files and instance kept, nothing created elsewhere", async () => {
    const s = service();
    const b = await seedCloud("device-fake-b");
    await run(s, b);
    const opsBefore = await opsOf(rootA);
    const opsBBefore = await opsOf(rootB);
    disable(orgId, "device-fake-b");
    expect(await s.availableFor(b, orgId)).toBe(false);
    await expect(run(s, b)).rejects.toMatchObject({ code: "device.unavailable", status: 503 });
    // provider A is never called for B's device, and B is not called either
    expect(await opsOf(rootA)).toEqual(opsBefore);
    expect(await opsOf(rootB)).toEqual(opsBBefore);
    expect(await instanceRow(b)).toMatchObject({
      provider: "device-fake-b",
      fs_status: "ready",
      status: "running",
    });
    expect(
      (await db.selectFrom("devices").select("provider").where("id", "=", b).executeTakeFirst())
        ?.provider,
    ).toBe("device-fake-b");
    // switched back on: the same instance on the same files
    enable(orgId, "device-fake-b");
    await run(s, b);
    expect(await opsOf(rootB, "create")).toHaveLength(1);
  });

  it("provider switched on in one org only: org B's device unavailable, org A's works", async () => {
    const s = service();
    const other = await seedOrg();
    const mine = await seedCloud("device-fake-b");
    const theirs = await seedCloud("device-fake-b", other.orgId, other.accountId);
    disable(other.orgId, "device-fake-b");
    await run(s, mine);
    await expect(run(s, theirs, other)).rejects.toMatchObject({ code: "device.unavailable" });
    expect(await s.availableFor(mine, orgId)).toBe(true);
    expect(await s.availableFor(theirs, other.orgId)).toBe(false);
    // the answer is read at every use: switched on there, it works at once
    enable(other.orgId, "device-fake-b");
    await run(s, theirs, other);
    expect(await opsOf(rootB, "create")).toHaveLength(2);
  });

  it("availableFor is false for a device of another org, a missing one and one without a provider", async () => {
    const s = service();
    const other = await seedOrg();
    const a = await seedCloud("device-fake");
    expect(await s.availableFor(a, other.orgId)).toBe(false);
    expect(await s.availableFor(randomUUID(), orgId)).toBe(false);
    await sql`UPDATE capybara.devices SET provider = NULL WHERE id = ${a}`.execute(raw);
    expect(await s.availableFor(a, orgId)).toBe(false);
    await expect(run(s, a)).rejects.toMatchObject({
      code: "device.unavailable",
      message: "This device has no provider; delete it and create a new one",
    });
  });

  it("an uninstalled provider: availableFor false, destroyDevice leaves the row for a retry", async () => {
    const b = await seedCloud("device-fake-b");
    await run(service(), b);
    const onlyA = service(() => [fakeA]);
    expect(await onlyA.availableFor(b, orgId)).toBe(false);
    await expect(run(onlyA, b)).rejects.toMatchObject({ code: "device.unavailable" });
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${b}`.execute(raw);
    await expect(onlyA.destroyDevice(b)).rejects.toThrow(/device-fake-b is not loaded/);
    expect(await instanceRow(b)).toMatchObject({ provider: "device-fake-b" });
    expect((await instanceRow(b))?.sweep_failed_at).toBeInstanceOf(Date);
    expect(await opsOf(rootA)).toEqual([]);
    expect(await opsOf(rootB, "destroy")).toEqual([]);
    // installed again: the gone-sweep finishes it with its own provider
    expect(await service().destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(b)).toBeUndefined();
    expect(await opsOf(rootB, "destroy-fs")).toHaveLength(1);
  });

  it("destroyDevice and resetFileSystem run while the org has the provider off (they need it loaded only)", async () => {
    const s = service();
    const b = await seedCloud("device-fake-b");
    await run(s, b);
    disable(orgId, "device-fake-b");
    await s.resetFileSystem(b);
    expect(await opsOf(rootB, "destroy-fs")).toHaveLength(1);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${b}`.execute(raw);
    await s.destroyDevice(b);
    expect(await instanceRow(b)).toBeUndefined();
    expect(await opsOf(rootA)).toEqual([]);
  });
});

describe("per-provider sweeps", () => {
  it("sweeps call each provider only for its rows", async () => {
    const s = service();
    const a = await seedCloud("device-fake");
    const b = await seedCloud("device-fake-b");
    await run(s, a);
    await run(s, b);
    // two idle running instances, one per provider
    expect(await s.suspendIdle(later(DAY))).toBe(2);
    expect(await opsOf(rootA, "suspend")).toHaveLength(1);
    expect(await opsOf(rootB, "suspend")).toHaveLength(1);
    expect(await instanceRow(a)).toMatchObject({ status: "suspended" });
    expect(await instanceRow(b)).toMatchObject({ status: "suspended" });
    // inactivity: one destroy each, with its own provider
    expect(await s.destroyInactive(later(365 * DAY))).toBe(2);
    expect(await opsOf(rootA, "destroy")).toHaveLength(1);
    expect(await opsOf(rootB, "destroy")).toHaveLength(1);
    // gone devices: each provider destroys its own files only
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id IN (${a}, ${b})`.execute(raw);
    expect(await s.destroyInactive(new Date())).toBe(2);
    expect(await opsOf(rootA, "destroy-fs")).toHaveLength(1);
    expect(await opsOf(rootB, "destroy-fs")).toHaveLength(1);
  });

  it("a provider unloaded between ticks: its idle rows stay running and untouched", async () => {
    const a = await seedCloud("device-fake");
    const b = await seedCloud("device-fake-b");
    await run(service(), a);
    await run(service(), b);
    const bBefore = await opsOf(rootB);
    const onlyA = service(() => [fakeA]);
    expect(await onlyA.suspendIdle(later(DAY))).toBe(1);
    expect(await onlyA.destroyInactive(later(365 * DAY))).toBe(1);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${b}`.execute(raw);
    expect(await onlyA.destroyInactive(new Date())).toBe(0);
    expect(await opsOf(rootB)).toEqual(bBefore);
    expect(await instanceRow(b)).toMatchObject({ provider: "device-fake-b", status: "running" });
    expect((await instanceRow(b))?.sweep_failed_at).toBeNull();
  });

  it("a provider off in the org is still swept (idle suspension is lifecycle, not use)", async () => {
    const s = service();
    const b = await seedCloud("device-fake-b");
    await run(s, b);
    disable(orgId, "device-fake-b");
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    expect(await instanceRow(b)).toMatchObject({ status: "suspended" });
  });

  it("the reconcile sweep keeps one cursor per provider that can update", async () => {
    const updatable = (e: DeviceProviderEntry): DeviceProviderEntry => ({
      ...e,
      impl: { ...e.impl, update: async () => "updated" as const },
    });
    const s = service(() => [updatable(fakeA), updatable(fakeB)]);
    await s.reconcileMarked();
    const keys = (await redis.keys("capk:sandbox-reconcile-cursor:*")).sort();
    expect(keys).toEqual([
      "capk:sandbox-reconcile-cursor:device-fake",
      "capk:sandbox-reconcile-cursor:device-fake-b",
    ]);
  });

  it("the reconcile sweep calls each provider only for its own marked devices", async () => {
    const updatable = (e: DeviceProviderEntry): DeviceProviderEntry => ({
      ...e,
      impl: { ...e.impl, update: async () => "updated" as const },
    });
    const a = await seedCloud("device-fake");
    const b = await seedCloud("device-fake-b");
    await run(service(), a);
    await run(service(), b);
    await sql`UPDATE capybara.devices SET permission_reconcile_required = true
      WHERE id IN (${a}, ${b})`.execute(raw);
    // only device-fake can update: device-fake-b's marked device is never visited
    const s = service(() => [updatable(fakeA), fakeB]);
    const visited = vi.spyOn(s, "reconcileLimits");
    await s.reconcileMarked();
    expect(visited.mock.calls.map((c) => c[0])).toEqual([a]);
  });
});

describe("@local beside the extension providers", () => {
  it("a device on @local resolves @local; a cloud device in the same org its own provider", async () => {
    const s = service();
    const dev = await seedLocal();
    const cl = await seedCloud();
    await run(s, dev);
    expect(await opsOf(localRoot, "create")).toHaveLength(1);
    expect(await opsOf(rootA)).toEqual([]);
    expect(await instanceRow(dev)).toMatchObject({ provider: LOCAL_PROVIDER, status: "running" });
    await run(s, cl);
    expect(await opsOf(rootA, "create")).toHaveLength(1);
    expect(await opsOf(localRoot, "create")).toHaveLength(1);
    expect(await instanceRow(cl)).toMatchObject({ provider: "device-fake" });
  });

  it("ifRunning, resetFileSystem and destroyDevice use the device's provider", async () => {
    const s = service();
    const dev = await seedLocal();
    await run(s, dev);
    const inst = await s.currentInstance(dev);
    expect(inst).not.toBeNull();
    const r = await s.ifRunning(dev, inst as { createdAt: Date }, async () => "ok");
    expect(r).toEqual({ kind: "ran", value: "ok" });
    await s.resetFileSystem(dev);
    expect(await opsOf(localRoot, "destroy-fs")).toHaveLength(1);
    await run(s, dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    await s.destroyDevice(dev);
    expect(await instanceRow(dev)).toBeUndefined();
    expect(await opsOf(rootA)).toEqual([]);
  });

  it("an internal provider's instance is suspended and destroyed for inactivity like any other", async () => {
    const dev = await seedLocal();
    await run(service(), dev);
    // without any extension provider too: each provider sweeps its own rows
    expect(await service(() => []).suspendIdle(later(DAY))).toBe(1);
    expect(await instanceRow(dev)).toMatchObject({ status: "suspended" });
    expect(await opsOf(localRoot, "suspend")).toHaveLength(1);
    expect(await service(() => []).destroyInactive(later(365 * DAY))).toBe(1);
    expect(await opsOf(localRoot, "destroy")).toHaveLength(1);
    // the instance only: its file system is kept for the next use
    expect(await opsOf(localRoot, "destroy-fs")).toEqual([]);
    expect(await opsOf(rootA)).toEqual([]);
  });

  it("a deleted org's local device instance is cleaned by the gone-sweep", async () => {
    const dev = await seedLocal();
    await run(service(), dev);
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${orgId}`.execute(raw);
    // without any extension provider too: @local alone serves the sweep
    expect(await service(() => []).destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
    expect(await opsOf(localRoot, "destroy")).toHaveLength(1);
    expect(await opsOf(localRoot, "destroy-fs")).toHaveLength(1);
    expect(await opsOf(rootA)).toEqual([]);
  });

  it("a deleted local device is cleaned by the gone-sweep; not while @local is missing", async () => {
    const dev = await seedLocal();
    await run(service(), dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    expect(await service(undefined, []).destroyInactive(new Date())).toBe(0);
    expect(await instanceRow(dev)).toBeDefined();
    expect(await service().destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
  });

  it("destroyDevice without the provider leaves the row for the sweep", async () => {
    const dev = await seedLocal();
    await run(service(), dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    await expect(service(undefined, []).destroyDevice(dev)).rejects.toThrow(/@local is not loaded/);
    expect((await instanceRow(dev))?.sweep_failed_at).toBeInstanceOf(Date);
    expect(await opsOf(localRoot, "destroy")).toEqual([]);
    // the provider is back: the sweep finishes it
    expect(await service().destroyInactive(new Date())).toBe(1);
    expect(await instanceRow(dev)).toBeUndefined();
  });

  it("a local device stays available when no extension provider is loaded", async () => {
    const s = service(() => []);
    const dev = await seedLocal();
    const cl = await seedCloud();
    expect(await s.availableFor(dev, orgId)).toBe(true);
    expect(await s.availableFor(cl, orgId)).toBe(false);
    await run(s, dev);
    const err = await run(s, cl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.unavailable");
  });

  it("a local device is unavailable while @local is not registered, whatever the org has on", async () => {
    const s = service(undefined, []);
    const dev = await seedLocal();
    expect(await s.availableFor(dev, orgId)).toBe(false);
    const err = await run(s, dev).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("device.unavailable");
    // never falls back to an extension provider
    expect(await opsOf(rootA)).toEqual([]);
    expect(await opsOf(rootB)).toEqual([]);
  });
});
