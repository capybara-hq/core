import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeviceProvider, StaleFenceError, ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { SandboxLockLostError } from "../../src/sandbox/leases.js";
import { appliedOf } from "../../src/sandbox/modes.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  mapSandboxError,
  SANDBOX_CREATE_FAILED_TEXT,
  SANDBOX_OPEN_NETWORK_REFUSED_TEXT,
} from "../../src/tools/builtins/sandbox/common.js";
import {
  createFakeSandbox,
  FAKE_REFUSAL_SECRET,
  type FakeSandboxOptions,
  fakeSandboxMeta,
  fakeSandboxState,
  readFakeSandboxLimits,
  readFakeSandboxOps,
  removeFakeSandbox,
  setFakeSandboxDelays,
  setFakeSandboxNetwork,
  setFakeSandboxRefuseOpenEgress,
} from "../fixtures/plugins/device-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import {
  managedUse,
  type SandboxServiceDeps,
  sandboxLeasesFor,
  sandboxServiceFor,
  seedDevice,
} from "../helpers/sandbox.js";

/**
 * Device modes and limits on cloud devices (auto mode spec §4.2, §4.3): an instance records the
 * mode and network kind it was made with; a use that finds another effective value updates the
 * instance (`update`), or recreates it on the kept files, or (a provider whose limits are fixed at
 * its file system, without `update`) keeps it and reports a pending file reset. A NULL record (an
 * instance made before auto mode) differs once. The host list, cpu and memory never trigger it.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: ReturnType<typeof KernelConfigSchema.parse>;
let root: string;
let provider: DeviceProvider;
const warned: string[] = [];
const log = { info() {}, warn: (m: string) => void warned.push(m), error() {} };
const signal = () => AbortSignal.timeout(30_000);

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
});

let orgId: string;
let accountId: string;
let deviceId: string;

async function newOrg(): Promise<{ orgId: string; accountId: string }> {
  const owner = randomUUID();
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${owner}, 'U')`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`o-${id.slice(0, 8)}`}, 'O', ${owner})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${randomUUID()}, ${id}, ${owner}, 'org', 1)`.execute(raw);
  return { orgId: id, accountId: owner };
}

/** A provider over the shared root with the given limits behaviour. */
const fake = (o: FakeSandboxOptions = {}) => createFakeSandbox(root, o);

beforeEach(async () => {
  warned.length = 0;
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs, capybara.automations, capybara.automation_runs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-modes-"));
  provider = fake();
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  ({ orgId, accountId } = await newOrg());
  deviceId = await seedDevice(raw, orgId);
});

const service = (
  p: () => DeviceProvider = () => provider,
  lockTtlMs?: number,
  extra: Partial<SandboxServiceDeps> = {},
) =>
  sandboxServiceFor({
    db,
    redis,
    providers: () => [{ plugin: "device-fake", version: "1.0.0", impl: p() }],
    config: () => config,
    log,
    lockPollMs: 20,
    ...(lockTtlMs !== undefined && { lockTtlMs }),
    ...extra,
  });

/**
 * The org's mode switch. `off` also selects the allowlist network (the org's `deviceNetwork`),
 * because a cloud device in sandbox mode applies it; `allowed` is auto mode, which ignores it.
 */
const setAutoMode = (mode: "allowed" | "off") =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
    outsideSandbox: mode,
    deviceNetwork: mode === "off" ? { ceiling: "allowlist" } : { default: "open" },
  })}::jsonb
    WHERE id = ${orgId}`.execute(raw);
const setOrgSettings = (value: unknown) =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify(value)}::jsonb
    WHERE id = ${orgId}`.execute(raw);
const record = async (id = deviceId) =>
  (
    await db
      .selectFrom("device_instances")
      .select("instance_limits")
      .where("device_id", "=", id)
      .executeTakeFirst()
  )?.instance_limits as Record<string, unknown> | null | undefined;
const modeOf = async (id = deviceId) => (await record(id))?.mode;
const networkKindOf = async (id = deviceId) =>
  ((await record(id))?.network as { kind?: string } | undefined)?.kind;

/** One use of the device on the managed route (as a tool call does); `sig` defaults to 30 s. */
const use = (s: SandboxService, runId?: string, id = deviceId, sig: AbortSignal = signal()) =>
  managedUse(
    s,
    {
      orgId,
      deviceId: id,
      holderConversationId: randomUUID(),
      actor: { accountId, conversationId: randomUUID(), ...(runId !== undefined && { runId }) },
    },
    async (h, _p, info) => ({ h, info }),
    sig,
  );

const status = async (id = deviceId) =>
  (
    await db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", id)
      .executeTakeFirst()
  )?.status;

const ops = async (op: string) => (await readFakeSandboxOps(root)).filter((o) => o[0] === op);

describe("creation records the effective mode and network", () => {
  it("a device follows the org: auto mode with the open public network, sandbox with the allowlist", async () => {
    const s = service();
    const a = await use(s);
    expect((await fakeSandboxMeta(root, a.h.id))?.limits).toMatchObject({
      network: { kind: "open-public" },
    });
    expect(await modeOf()).toBe("auto");
    expect(await networkKindOf()).toBe("open-public");

    const other = await seedDevice(raw, orgId);
    await setAutoMode("off");
    const b = await use(s, undefined, other);
    expect((await fakeSandboxMeta(root, b.h.id))?.limits).toMatchObject({
      network: { kind: "allowlist" },
    });
    expect(await modeOf(other)).toBe("sandbox");
    expect(await networkKindOf(other)).toBe("allowlist");
  });
});

describe("a changed mode on use", () => {
  it("update answers updated: the same instance, the new limits, no restart", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const state = await s.limitsState({ orgId, deviceId });
    expect(state.applied).toMatchObject({ mode: "auto", network: { kind: "open-public" } });
    expect(state.effective).toMatchObject({ mode: "sandbox", network: { kind: "allowlist" } });
    expect(state.pendingNextUse).toBe(true);
    expect(state.pendingFilesReset).toBe(false);
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates.map((e) => e.limits.network.kind)).toEqual(["allowlist"]);
    expect(await modeOf()).toBe("sandbox");
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(false);
    // applied once: the next use takes a shared lease and changes nothing
    await use(s);
    expect(await ops("update")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
  });

  it("update answers recreate: the instance is recreated on the kept files with a restart", async () => {
    provider = fake({ updateMode: "recreate" });
    const s = service();
    const first = await use(s);
    const fs = (await fakeSandboxMeta(root, first.h.id))?.fileSystem;
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "recreate"]]);
    expect(await ops("destroy")).toEqual([["destroy", first.h.id]]);
    expect(await ops("create-fs")).toHaveLength(1);
    const meta = await fakeSandboxMeta(root, again.h.id);
    expect(meta?.fileSystem).toBe(fs);
    expect(meta?.limits).toMatchObject({ network: { kind: "allowlist" } });
    expect(await modeOf()).toBe("sandbox");
  });

  it("no update (Docker today): destroy and create on the same files, files kept", async () => {
    const s = service();
    const first = await use(s);
    const fsOf = async (id: string) => (await fakeSandboxMeta(root, id))?.fileSystem;
    const fs = await fsOf(first.h.id);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await fsOf(again.h.id)).toBe(fs);
    expect(await ops("create")).toHaveLength(2);
    expect(await modeOf()).toBe("sandbox");
  });

  it("a suspended instance is resumed, then gets the new mode", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await s.suspendIdle(new Date(Date.now() + 24 * 60 * 60_000));
    expect(await ops("suspend")).toHaveLength(1);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await modeOf()).toBe("sandbox");
  });

  it("limits fixed at the file system, no update: keeps running as is, pending a file reset", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    expect(await modeOf()).toBe("auto");
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("create")).toHaveLength(1);
    expect(await modeOf()).toBe("auto");
    const state = await s.limitsState({ orgId, deviceId });
    expect(state).toMatchObject({ pendingNextUse: false, pendingFilesReset: true });
    // a file reset applies it
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await use(s);
    expect(await modeOf()).toBe("sandbox");
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(false);
  });

  it("limits fixed at the file system, update answers recreate: recorded unapplied, not retried", async () => {
    provider = fake({ limitsApplyAt: "fileSystem", updateMode: "recreate" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("create")).toHaveLength(1);
    const rec = (await record()) as { unapplied?: { mode?: string } };
    expect(rec.unapplied).toMatchObject({ mode: "sandbox", network: { kind: "allowlist" } });
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(true);
    await use(s);
    expect(await ops("update")).toHaveLength(1);
  });

  it("a mode changed while a use waits for the lease is applied before that use runs", async () => {
    provider = fake({ updateMode: "updated" });
    const leases = sandboxLeasesFor({ redis, log: {}, pollMs: 20 });
    const s = sandboxServiceFor({
      db,
      redis,
      providers: () => [{ plugin: "device-fake", version: "1.0.0", impl: provider }],
      config: () => config,
      log,
      lockPollMs: 20,
      leases,
    });
    const first = await use(s);
    // another holder (a sweep) has the device alone: the use reads its limits, then waits
    const ex = await leases.tryExclusive(deviceId);
    expect(ex).not.toBeNull();
    const waiting = use(s);
    await new Promise((r) => setTimeout(r, 150));
    await setAutoMode("off");
    await ex?.release();
    const again = await waiting;
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await modeOf()).toBe("sandbox");
  });

  it.each(["org", "platform"] as const)(
    "the %s outside-sandbox setting alone never changes a cloud instance's applied limits",
    async (layer) => {
      // a cloud device has no outside of its sandbox: toggling the setting is no provider update
      // (Docker would drop its egress proxy) and no pending change
      provider = fake({ updateMode: "updated" });
      const s = service();
      const first = await use(s);
      const before = await record();
      if (layer === "org") await setOrgSettings({ outsideSandbox: "off" });
      else
        config = KernelConfigSchema.parse({
          ...config,
          devices: { ...config.devices, outsideSandbox: "off" },
        });
      expect(await s.limitsState({ orgId, deviceId })).toMatchObject({
        pendingNextUse: false,
        pendingFilesReset: false,
      });
      const again = await use(s);
      expect(again.h).toEqual(first.h);
      expect(again.info).toMatchObject({ fresh: false, restarted: false });
      expect(await ops("update")).toEqual([]);
      expect(await ops("create")).toHaveLength(1);
      expect(await record()).toEqual(before);
    },
  );

  it("a NULL record (an instance made before auto mode) differs once", async () => {
    const s = service();
    await use(s);
    await sql`UPDATE capybara.device_instances SET instance_limits = NULL
      WHERE device_id = ${deviceId}`.execute(raw);
    const again = await use(s);
    expect(again.info).toMatchObject({ restarted: true });
    expect(await modeOf()).toBe("auto");
    await use(s);
    expect(await ops("create")).toHaveLength(2);
  });

  // device-provider spec §6.3: a host added to a list reaches the existing instance at its next
  // use, once (the record then covers it); resources alone still wait for a new instance
  it("a widened host list reaches the running instance once at its next use; cpu or memory alone never", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["example.com"] },
    });
    expect(await s.limitsState({ orgId, deviceId })).toMatchObject({
      pendingNextUse: true,
      pendingFilesReset: false,
    });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    const network = (await record())?.network as { hosts?: string[] } | undefined;
    expect(network?.hosts).toContain("example.com");
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(false);
    // applied once: no loop
    await use(s);
    expect(await ops("update")).toHaveLength(1);
    await sql`INSERT INTO capybara.deployment_settings (key, value)
      VALUES ('sandboxLimitOverrides', ${JSON.stringify({ [orgId]: { cpu: 4 } })}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
    await use(s);
    expect(await ops("update")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
    await sql`DELETE FROM capybara.deployment_settings WHERE key = 'sandboxLimitOverrides'`.execute(
      raw,
    );
  });

  it("a widened host list without update recreates the instance on its kept files at its next use", async () => {
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    const fs = (await fakeSandboxMeta(root, first.h.id))?.fileSystem;
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["example.com"] },
    });
    const again = await use(s);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect((await fakeSandboxMeta(root, again.h.id))?.fileSystem).toBe(fs);
    expect(
      ((await fakeSandboxMeta(root, again.h.id))?.limits as { network?: { hosts?: string[] } })
        ?.network?.hosts,
    ).toContain("example.com");
    await use(s);
    expect(await ops("create")).toHaveLength(2);
  });

  it("limits fixed at the file system: a widened host list waits for a file reset", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["example.com"] },
    });
    expect(await s.limitsState({ orgId, deviceId })).toMatchObject({
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("create")).toHaveLength(1);
    await s.resetFileSystem(deviceId);
    await use(s);
    const network = (await record())?.network as { hosts?: string[] } | undefined;
    expect(network?.hosts).toContain("example.com");
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(false);
  });

  it("a host-only narrowing reaches the running instance on its next use (spec §124)", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", excludedHosts: ["pypi.org"] },
    });
    // the device page says so before the use applies it
    expect(await s.limitsState({ orgId, deviceId })).toMatchObject({
      pendingNextUse: true,
      pendingFilesReset: false,
    });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toHaveLength(1);
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(false);
    const network = (await record())?.network as { hosts?: string[] } | undefined;
    expect(network?.hosts).toContain("github.com");
    expect(network?.hosts).not.toContain("pypi.org");
  });

  it("limits fixed at the file system, no update: a host-only narrowing is pending a file reset", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    await setAutoMode("off");
    await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", excludedHosts: ["pypi.org"] },
    });
    expect(await s.limitsState({ orgId, deviceId })).toMatchObject({
      pendingNextUse: false,
      pendingFilesReset: true,
    });
  });
});

// device update fencing design §7, §9: every lifecycle call carries the holder's committed
// fencing generation; the intent of an update is recorded before it is sent
describe("fencing token and update intent", () => {
  const hostsOf = (rec: Record<string, unknown> | null | undefined) =>
    (rec?.network as { hosts?: string[] } | undefined)?.hosts ?? [];
  /** The row as another connection sees it now (only committed writes). */
  const committed = async () =>
    (
      await sql<{ generation: number; instance_limits: Record<string, unknown> | null }>`
        SELECT generation, instance_limits FROM capybara.device_instances
        WHERE device_id = ${deviceId}`.execute(raw)
    ).rows[0];

  it("create and update carry the generation already committed, and the intent precedes the update", async () => {
    const base = fake({ updateMode: "updated" });
    const seen: { op: string; token: number; row: Awaited<ReturnType<typeof committed>> }[] = [];
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      create: async (a: Parameters<DeviceProvider["create"]>[0]) => {
        seen.push({ op: "create", token: a.fence.token, row: await committed() });
        return base.create(a);
      },
      update: async (...a: Parameters<NonNullable<DeviceProvider["update"]>>) => {
        seen.push({ op: "update", token: a[3].token, row: await committed() });
        return (base.update as NonNullable<DeviceProvider["update"]>)(...a);
      },
    });
    const s = service();
    await setAutoMode("off");
    await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["example.com"] },
    });
    await use(s);
    expect(seen.map((c) => c.op)).toEqual(["create", "update"]);
    for (const c of seen) expect(c.token).toBe(c.row?.generation);
    // the intent: what was in force stays `applied`, the target is `pending` while the call runs
    const during = seen[1]?.row?.instance_limits;
    expect(hostsOf(during)).not.toContain("example.com");
    expect(hostsOf(during?.pending as Record<string, unknown> | undefined)).toContain(
      "example.com",
    );
    // answered `updated`: recorded, the intent cleared
    const after = await record();
    expect(after?.pending).toBeUndefined();
    expect(hostsOf(after)).toContain("example.com");
  });

  it("a StaleFenceError from update is a lost lease: nothing recreated, nothing recorded", async () => {
    const base = fake({ updateMode: "updated" });
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      update: async () => {
        throw new StaleFenceError("a newer holder applied a higher token", { current: 99 });
      },
    });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    await setOrgSettings({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["example.com"] },
    });
    await expect(use(s)).rejects.toBeInstanceOf(SandboxLockLostError);
    expect(await ops("create")).toHaveLength(1);
    expect(await ops("destroy")).toHaveLength(0);
    // a stale holder touches nothing more (no quarantine of what a newer holder may use)
    expect(await ops("suspend")).toHaveLength(0);
    expect(await status()).toBe("running");
    expect((await fakeSandboxMeta(root, first.h.id))?.limits.network).not.toMatchObject({
      hosts: expect.arrayContaining(["example.com"]),
    });
    // never recorded as applied; the intent stays for the next holder
    const rec = await record();
    expect(hostsOf(rec)).not.toContain("example.com");
    expect(rec?.pending).toBeDefined();
    // here the record still holds (only the provider is ahead), so the kernel raised its generation
    expect(warned).toContain(
      "a device provider holds a fence token ahead of the device record; generation raised so the next use applies again",
    );
  });

  it("a StaleFenceError from create while the record still holds heals: the generation passes the provider's token", async () => {
    const base = fake();
    let refuse = true;
    const tokens: number[] = [];
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      create: async (a: Parameters<DeviceProvider["create"]>[0]) => {
        tokens.push(a.fence.token);
        if (refuse) {
          refuse = false;
          throw new StaleFenceError("the instance holds a newer token", { current: 1000 });
        }
        return base.create(a);
      },
    });
    const s = service();
    // this holder still holds the record: the provider is ahead of it (a restored database)
    await expect(use(s)).rejects.toBeInstanceOf(SandboxLockLostError);
    expect((await committed())?.generation).toBeGreaterThan(1000);
    expect(warned).toContain(
      "a device provider holds a fence token ahead of the device record; generation raised so the next use applies again",
    );
    await use(s);
    expect(tokens[1]).toBeGreaterThan(1000);
  });

  it("the lifecycle reconcile records its intent; an answer that changed nothing restores the record, a failure keeps it", async () => {
    const base = fake({ updateMode: "recreate" });
    let answer: "recreate" | "throw" = "recreate";
    const during: (Record<string, unknown> | null | undefined)[] = [];
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      update: async (...a: Parameters<NonNullable<DeviceProvider["update"]>>) => {
        during.push((await committed())?.instance_limits);
        if (answer === "throw") throw new Error("provider down");
        return (base.update as NonNullable<DeviceProvider["update"]>)(...a);
      },
    });
    await setAutoMode("off");
    await use(service());
    const before = await record();
    const policy = await service().devicePolicy({ orgId, deviceId });
    const target = appliedOf({ mode: policy.mode, network: policy.network });
    const s = service(undefined, undefined, {
      snapshots: {
        reconcileHeld: async () => ({ state: "reconcile-required", action: "reset-files", target }),
      },
    });
    await s.reconcileLimits(deviceId);
    expect(during[0]?.pending).toBeDefined();
    expect(await record()).toEqual(before);
    answer = "throw";
    await s.reconcileLimits(deviceId);
    expect((await record())?.pending).toBeDefined();
  });

  it("a recorded intent whose applied limits match the desired ones is applied again at the next use", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    const rec = await record();
    // an update sent by a holder that never heard back, to limits the org since left again
    await sql`UPDATE capybara.device_instances
      SET instance_limits = ${JSON.stringify({
        ...rec,
        pending: { ...rec, network: { kind: "allowlist", hosts: ["wide.example"] } },
      })}::jsonb WHERE device_id = ${deviceId}`.execute(raw);
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(true);
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.limits.network).toMatchObject({ kind: "allowlist" });
    expect(
      updates[0]?.limits.network.kind === "allowlist" && updates[0].limits.network.hosts,
    ).not.toContain("wide.example");
    expect((await record())?.pending).toBeUndefined();
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(false);
  });
});

/**
 * Issue #766: a provider whose `update` cannot honor the fence (E2B) may end up enforcing a stale
 * replica's wider list after the newer holder's change. The instance's installed network
 * (`appliedNetwork`) is read at a lifecycle step under the exclusive lease; wider than the record
 * (or unknown) applies the desired limits again, equal or narrower changes nothing.
 */
describe("installed network wider than the record (#766)", () => {
  const hostsOf = (rec: Record<string, unknown> | null | undefined) =>
    ((rec?.network as { hosts?: string[] } | undefined)?.hosts ?? []).slice();
  const later = () => new Date(Date.now() + 24 * 60 * 60_000);
  const updates = async () => (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
  const sentHosts = (e: Awaited<ReturnType<typeof updates>>[number] | undefined) =>
    e?.limits.network.kind === "allowlist" ? e.limits.network.hosts : ["<open-public>"];

  /** A running instance on the org's allowlist, then suspended (its next use resumes it). */
  async function suspendedOnAllowlist(o: FakeSandboxOptions = {}) {
    provider = fake({ updateMode: "updated", reportsNetwork: true, ...o });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    const rec = await record();
    // a new instance is read only when its limits are fixed at its file system (createSettled)
    const reads = (await ops("applied-network")).length;
    expect(reads).toBe(o.limitsApplyAt === "fileSystem" ? 1 : 0);
    // a shared use of the running instance reads nothing: the check is on lifecycle steps only
    await use(s);
    expect(await ops("applied-network")).toHaveLength(reads);
    await s.suspendIdle(later());
    return { s, first, rec };
  }

  it("a resumed instance allowing a host the record lacks gets the desired list again", async () => {
    const { s, first, rec } = await suspendedOnAllowlist();
    await setFakeSandboxNetwork(root, first.h.id, {
      kind: "allowlist",
      hosts: [...hostsOf(rec), "wide.example"],
    });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("applied-network")).toHaveLength(1);
    const sent = await updates();
    expect(sent).toHaveLength(1);
    expect(sentHosts(sent[0])).toEqual(hostsOf(rec));
    expect(hostsOf((await fakeSandboxMeta(root, first.h.id))?.limits as never)).not.toContain(
      "wide.example",
    );
    expect(await record()).toEqual(rec);
    expect(await ops("create")).toHaveLength(1);
  });

  it("a resumed instance on the open public network while the record is a list is narrowed", async () => {
    const { s, first, rec } = await suspendedOnAllowlist();
    await setFakeSandboxNetwork(root, first.h.id, { kind: "open-public", hosts: [] });
    await use(s);
    const sent = await updates();
    expect(sent).toHaveLength(1);
    expect(sentHosts(sent[0])).toEqual(hostsOf(rec));
    expect((await fakeSandboxMeta(root, first.h.id))?.limits.network.kind).toBe("allowlist");
  });

  it("an equal or narrower installed network changes nothing", async () => {
    const { s, first, rec } = await suspendedOnAllowlist();
    await use(s);
    expect(await ops("applied-network")).toHaveLength(1);
    await s.suspendIdle(later());
    await setFakeSandboxNetwork(root, first.h.id, {
      kind: "allowlist",
      hosts: hostsOf(rec).slice(1),
    });
    await use(s);
    expect(await ops("applied-network")).toHaveLength(2);
    expect(await updates()).toHaveLength(0);
    expect(await record()).toEqual(rec);
  });

  it("an installed network the provider cannot tell, or a failed read, applies the desired list again", async () => {
    const { s, rec } = await suspendedOnAllowlist();
    const base = provider;
    let answer: "null" | "throw" = "null";
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      appliedNetwork: async () => {
        if (answer === "throw") throw new Error("backend unavailable");
        return null;
      },
    });
    await use(s);
    expect((await updates()).map(sentHosts)).toEqual([hostsOf(rec)]);
    await s.suspendIdle(later());
    answer = "throw";
    await use(s);
    expect((await updates()).map(sentHosts)).toEqual([hostsOf(rec), hostsOf(rec)]);
    expect(warned).toContain(
      "cannot read the instance's installed network; applying the desired limits again",
    );
    expect((await record())?.pending).toBeUndefined();
  });

  it("limits fixed at the file system (E2B): a wider installed network is narrowed through update", async () => {
    const { s, first, rec } = await suspendedOnAllowlist({ limitsApplyAt: "fileSystem" });
    await setFakeSandboxNetwork(root, first.h.id, {
      kind: "allowlist",
      hosts: [...hostsOf(rec), "wide.example"],
    });
    await use(s);
    expect((await updates()).map(sentHosts)).toEqual([hostsOf(rec)]);
    expect(hostsOf((await fakeSandboxMeta(root, first.h.id))?.limits as never)).not.toContain(
      "wide.example",
    );
    expect(await ops("create")).toHaveLength(1);
  });

  it("limits fixed at the file system: an update that cannot narrow a wider instance stops it and keeps the intent", async () => {
    const { s, first, rec } = await suspendedOnAllowlist({
      limitsApplyAt: "fileSystem",
      updateMode: "recreate",
    });
    await setFakeSandboxNetwork(root, first.h.id, { kind: "open-public", hosts: [] });
    const err = await use(s).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/enforces a wider network than its recorded limits/);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    // never recorded unapplied (that would claim the instance runs the record); the intent stays
    const after = await record();
    expect(after?.unapplied).toBeUndefined();
    expect(hostsOf(after?.pending as Record<string, unknown> | undefined)).toEqual(hostsOf(rec));
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(true);
  });

  it("limits fixed at the file system: an instance created on kept files that came up wider is narrowed", async () => {
    const { s, first, rec } = await suspendedOnAllowlist({ limitsApplyAt: "fileSystem" });
    // the instance is gone; the next one comes up with the network its file system kept (E2B)
    await removeFakeSandbox(root, first.h.id);
    const base = provider;
    provider = Object.assign(Object.create(base) as DeviceProvider, {
      create: async (a: Parameters<DeviceProvider["create"]>[0]) => {
        const h = await base.create(a);
        await setFakeSandboxNetwork(root, h.id, { kind: "open-public", hosts: [] });
        return h;
      },
    });
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect((await updates()).map(sentHosts)).toEqual([hostsOf(rec)]);
    expect((await fakeSandboxMeta(root, again.h.id))?.limits.network.kind).toBe("allowlist");
    expect((await record())?.pending).toBeUndefined();
  });

  it("an instance-bound provider's new instance is not read: create applied the desired limits", async () => {
    const { s, first } = await suspendedOnAllowlist();
    await removeFakeSandbox(root, first.h.id);
    await use(s);
    expect(await ops("create")).toHaveLength(2);
    expect(await ops("applied-network")).toHaveLength(0);
    expect(await updates()).toHaveLength(0);
  });
});

describe("a provider that refuses the open public network", () => {
  /** The refusal and the tool text it becomes; the provider's own message never reaches it. */
  const refused = async (err: unknown) => {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.open_network_refused");
    expect((err as Error).message).not.toContain(FAKE_REFUSAL_SECRET);
    const tool = mapSandboxError(err, undefined) as Error;
    expect(tool).toBeInstanceOf(ToolError);
    expect(tool.message).toBe(SANDBOX_OPEN_NETWORK_REFUSED_TEXT);
    expect(tool.message).not.toContain(FAKE_REFUSAL_SECRET);
    expect(tool.message).not.toContain("openEgress");
    // provider-neutral and actionable (hardening spec K5): what an admin can do now, never a
    // provider setting that may not exist
    for (const text of [(err as Error).message, tool.message]) {
      expect(text).toMatch(/cloud network to an allowlist/);
      expect(text).toMatch(/provider that offers the open network/);
      expect(text).not.toMatch(/extension's settings|openEgress|refuseOpenNetwork/);
    }
    expect(warned.some((m) => m.includes("refused an instance with the open public network"))).toBe(
      true,
    );
  };

  it("a new instance in auto mode: the create is refused; sandbox mode works on the same provider", async () => {
    await setFakeSandboxRefuseOpenEgress(root, true);
    await refused(await use(service()).catch((e: unknown) => e));
    await setAutoMode("off");
    expect((await use(service())).info).toMatchObject({ fresh: true });
  });

  it("a running instance moved to auto mode: the failed update recreates, and that create is refused", async () => {
    await setAutoMode("off");
    provider = fake({ updateMode: "updated" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setAutoMode("allowed");
    await refused(await use(s).catch((e: unknown) => e));
  });

  it("limits fixed at the file system: a new file system in auto mode is refused", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    await setFakeSandboxRefuseOpenEgress(root, true);
    await refused(await use(service()).catch((e: unknown) => e));
    expect(await ops("create-fs")).toEqual([]);
  });

  it("limits fixed at the file system: a refused update suspends the instance with the error", async () => {
    await setAutoMode("off");
    provider = fake({ updateMode: "updated", limitsApplyAt: "fileSystem" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setAutoMode("allowed");
    await refused(await use(s).catch((e: unknown) => e));
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("sandbox");
  });

  it("any other create failure becomes sandbox.create_failed without the provider's message", async () => {
    await setAutoMode("off");
    const failing = fake();
    const p: DeviceProvider = Object.create(failing);
    p.create = async () => {
      throw new Error(`no image configured (${FAKE_REFUSAL_SECRET})`);
    };
    const err = await use(service(() => p)).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("sandbox.create_failed");
    expect((err as Error).message).not.toContain(FAKE_REFUSAL_SECRET);
    expect((mapSandboxError(err, undefined) as Error).message).toBe(SANDBOX_CREATE_FAILED_TEXT);
    expect(warned).toContain("the sandbox provider failed to create a device's sandbox");
  });
});

describe("a failed limits change", () => {
  it("an update that fails on a provider bound to instances recreates it; nothing claims the update", async () => {
    provider = fake({ updateMode: "throw" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "throw"]]);
    // recorded by the create that applied it
    expect(await modeOf()).toBe("sandbox");
    expect((await fakeSandboxMeta(root, again.h.id))?.limits.network.kind).toBe("allowlist");
    expect(warned.some((m) => m.includes("update failed"))).toBe(true);
  });

  it("an update aborted on a provider bound to instances suspends the instance instead of recreating it", async () => {
    provider = fake({ updateMode: "throw" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    await setFakeSandboxDelays(root, { update: 5000 });
    const ac = new AbortController();
    const run = use(s, undefined, deviceId, ac.signal).catch((e: unknown) => e);
    // aborted while the update runs: the instance may hold half-applied limits
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    expect(await run).toBeInstanceOf(Error);
    await setFakeSandboxDelays(root, {});
    expect(await ops("update")).toEqual([]);
    expect(await ops("create")).toHaveLength(1);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("auto");
  });

  it("an update that fails on a provider bound to its file system suspends the instance and throws", async () => {
    provider = fake({ updateMode: "throw", limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const err = await use(s).catch((e: unknown) => e);
    expect((err as Error).message).toBe("fake update failed");
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("auto");
    // the next use resumes it, tries again, and leaves it suspended when that fails too
    await use(s).catch(() => undefined);
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("update")).toHaveLength(2);
    expect(await status()).toBe("suspended");
    expect(await ops("create")).toHaveLength(1);
  });

  it("a failed limits change on a resumed instance revokes its generation exactly, never killAll (B-1)", async () => {
    provider = fake({ updateMode: "throw", limitsApplyAt: "fileSystem" });
    const revoked: string[] = [];
    const s = service(undefined, undefined, {
      operationIntents: {
        revokeIncarnation: async (_env, inst) =>
          void revoked.push(`${inst.provider}@${inst.generation}`),
      },
    });
    const first = await use(s);
    const generation = String((await s.currentInstance(deviceId))?.createdAt.getTime());
    await setAutoMode("off");
    // the failed update suspends it (the provider could suspend: nothing to revoke while paused)
    await use(s).catch(() => undefined);
    expect(revoked).toEqual([]);
    // the next use resumes it; the update fails again: what the pause brought back is revoked
    await use(s).catch(() => undefined);
    expect(await ops("resume")).toHaveLength(1);
    expect(revoked).toEqual([`device-fake@${generation}`]);
    expect(await ops("kill-all")).toEqual([]);
    expect(await ops("kill-tagged")).toEqual([]);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
  });

  it("a quarantine that cannot suspend revokes the generation exactly, never killAll (B-1)", async () => {
    const p = fake({ updateMode: "throw", limitsApplyAt: "fileSystem" });
    p.suspend = async () => {
      throw new Error("suspend failed");
    };
    provider = p;
    const revoked: string[] = [];
    const s = service(undefined, undefined, {
      operationIntents: {
        revokeIncarnation: async (_env, inst) => void revoked.push(inst.generation),
      },
    });
    await use(s);
    const generation = String((await s.currentInstance(deviceId))?.createdAt.getTime());
    await setAutoMode("off");
    await use(s).catch(() => undefined);
    expect(revoked).toEqual([generation]);
    expect(await ops("kill-all")).toEqual([]);
    expect(await status()).toBe("suspended");
  });

  it("a lease lost during update records nothing and stops the instance", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service(undefined, 300);
    const first = await use(s);
    await setAutoMode("off");
    await setFakeSandboxDelays(root, { update: 2000 });
    const run = use(s).catch((e: unknown) => e);
    // the exclusive lease expires under the slow update
    await new Promise((r) => setTimeout(r, 150));
    await redis.del(`capk:sandbox:${deviceId}`, `capk:sandbox-users:${deviceId}`);
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    await setFakeSandboxDelays(root, {});
    expect(await modeOf()).toBe("auto");
    expect(await ops("update")).toEqual([]);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
  });

  it("a file reset clears the record of an instance provider; the next create records again", async () => {
    const s = service();
    await use(s);
    expect(await modeOf()).toBe("auto");
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await setAutoMode("off");
    await use(s);
    expect(await modeOf()).toBe("sandbox");
  });
});

describe("scheduled runs use the effective mode like any use", () => {
  it("an unattended run needs no mode grant: it uses the effective mode and records no missing grant", async () => {
    const s = service();
    await setAutoMode("off");
    const taskId = randomUUID();
    const taskRunId = randomUUID();
    const runId = randomUUID();
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.automations (id, org_id, account_id, agent_id, name, prompt,
        trigger, mode, device_id)
      VALUES (${taskId}, ${orgId}, ${accountId}, 'agent', 'T', 'p',
        ${JSON.stringify({ kind: "cron", expr: "0 9 * * *", timeZone: "UTC" })}::jsonb, 'new',
        ${deviceId})`.execute(raw);
    await sql`INSERT INTO capybara.automation_runs (id, automation_id, org_id, scheduled_for,
        trigger_key, trial, status)
      VALUES (${taskRunId}, ${taskId}, ${orgId}, now(), ${taskRunId}, false, 'running')`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      SELECT ${conversationId}, ${orgId}, a.id, ${accountId}
      FROM capybara.agents a WHERE a.org_id = ${orgId} LIMIT 1`.execute(raw);
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
        trigger_account_id, trigger_seq, automation_run_id)
      VALUES (${runId}, ${conversationId}, 'running', 1, ${accountId}, 0, ${taskRunId})`.execute(
      raw,
    );
    await use(s, runId);
    expect(await modeOf()).toBe("sandbox");
    const row = await db
      .selectFrom("automation_runs")
      .select("missing_grants")
      .where("id", "=", taskRunId)
      .executeTakeFirstOrThrow();
    expect(row.missing_grants).toEqual([]);
  });
});

describe("the lifecycle reconcile sweep (B-12)", () => {
  it("visits every marked device across ticks: a stuck first page never starves the rest", async () => {
    provider = fake({ updateMode: "updated" });
    const tried: string[] = [];
    const s = sandboxServiceFor({
      db,
      redis,
      providers: () => [{ plugin: "device-fake", version: "1.0.0", impl: provider }],
      config: () => config,
      log,
      lockPollMs: 20,
      snapshots: {
        reconcileHeld: async (_org, id) => {
          tried.push(id);
          // stuck: the marker stays and no target applies
          return { state: "reconcile-required", action: "reset-files" };
        },
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await seedDevice(raw, orgId);
      ids.push(id);
      await sql`UPDATE capybara.devices SET permission_reconcile_required = true
        WHERE id = ${id}`.execute(raw);
      await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status, handle,
          fs_status, fs_handle)
        VALUES (${id}, ${orgId}, 'device-fake', 'running', ${JSON.stringify({ id: `fake-${i}` })}::jsonb,
          'ready', ${JSON.stringify({ id: `fs-${i}` })}::jsonb)`.execute(raw);
    }
    await s.reconcileMarked();
    expect(tried).toHaveLength(10);
    await s.reconcileMarked();
    expect([...new Set(tried)].sort()).toEqual([...ids].sort());
  });
});
