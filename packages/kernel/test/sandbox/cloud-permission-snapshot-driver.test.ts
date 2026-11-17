import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { createLogger } from "../../src/log.js";
import { CloudPermissionSnapshots } from "../../src/sandbox/cloud-permission-snapshot.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * B-10: the production driver of the cloud snapshot (`capybara permissions cutover snapshot`). It
 * runs only behind the cutover barrier (the legacy-launch freeze published and enumerated) on a
 * replica whose permission configuration is current, snapshots every live cloud device without a
 * snapshot under its lifecycle lease, publishes nothing on a rerun and resumes after a crash
 * without publishing twice. The file's tests share one database and run in order: the barrier
 * cases come first, before the freeze exists.
 */
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let db: KernelDb;
const log = createLogger("error", { write: () => {} });
const PROVIDER = "@b10-snapshot-driver-test";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 5).toString("base64"),
      roles: ["api"],
      http: { port: 0 },
      marketplaces: { official: { enabled: false } },
    }),
    { env: {}, logger: log },
  );
  db = k.app.get(KernelDb);
  k.app.get(SandboxProviders).register({
    plugin: PROVIDER,
    version: "test",
    impl: {
      operation() {
        throw new Error("provider IO forbidden");
      },
      permissionSupport() {
        throw new Error("provider IO forbidden");
      },
      revokeOperation() {
        throw new Error("provider IO forbidden");
      },
    } as unknown as SandboxProvider,
  });
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const snapshots = () => k.app.get(CloudPermissionSnapshots);
const retirement = () => k.app.get(LegacyRetirementStore);
const STRICT = { mode: "sandbox", network: { kind: "allowlist", hosts: [] } };

/** A device of a fresh org with a conversation on it; `instance` adds a running instance row. */
async function fixture(
  opts: { source?: "cloud" | "local"; instance?: unknown; deleted?: boolean } = {},
) {
  const accountId = randomUUID(),
    orgId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID(),
    deviceId = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "B10", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({ id: orgId, slug: orgId, name: "B10", created_by: accountId, settings: "{}" })
    .execute();
  await db
    .insertInto("memberships")
    .values({ org_id: orgId, account_id: accountId, role: "owner" })
    .execute();
  await db
    .insertInto("agents")
    .values({
      id: agentId,
      org_id: orgId,
      owner_account_id: accountId,
      visibility: "org",
      current_version: 1,
    })
    .execute();
  const source = opts.source ?? "cloud";
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      source,
      provider: source === "cloud" ? PROVIDER : null,
      mode: null,
      ...(opts.deleted && { deleted_at: new Date() }),
    })
    .execute();
  if (opts.instance !== undefined)
    await db
      .insertInto("device_instances")
      .values({
        device_id: deviceId,
        org_id: orgId,
        provider: PROVIDER,
        handle: JSON.stringify({ id: deviceId }),
        status: "running",
        fs_status: "ready",
        fs_handle: JSON.stringify({ id: `fs-${deviceId}` }),
        instance_limits: opts.instance === null ? null : JSON.stringify(opts.instance),
      })
      .execute();
  await db
    .insertInto("conversations")
    .values({
      id: conversationId,
      org_id: orgId,
      account_id: accountId,
      agent_id: agentId,
      title: null,
      source: "web",
      device_id: deviceId,
      permission_profile: "full-access",
      permission_consent: JSON.stringify({ deviceId, scopeRevision: "x" }),
    })
    .execute();
  const device = () =>
    db
      .selectFrom("devices")
      .select(["owner_full_access", "permission_reconcile_required"])
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
  const root = async () =>
    (
      await db
        .selectFrom("conversations")
        .select("permission_profile")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow()
    ).permission_profile;
  const epoch = async () =>
    (
      await db
        .selectFrom("permission_authority_epochs")
        .select("revision")
        .where("kind", "=", "device")
        .where("id", "=", deviceId)
        .executeTakeFirst()
    )?.revision ?? 0;
  return { orgId, deviceId, device, root, epoch };
}

it("refuses while legacy admission is open (no freeze) and writes nothing", async () => {
  const f = await fixture();
  await expect(snapshots().snapshotAll()).rejects.toThrow(/freeze/);
  expect((await f.device()).owner_full_access).toBeNull();
});

it("refuses a freeze whose enumeration never completed, until the freeze is run again", async () => {
  const f = await fixture();
  // a freeze published by a run that crashed before its enumeration finished
  await db
    .insertInto("legacy_launch_freeze")
    .values({ id: "platform", frozen_by: "crashed run" })
    .execute();
  expect(await retirement().frozen()).toBe(true);
  await expect(snapshots().snapshotAll()).rejects.toThrow(/enumerat/);
  expect((await f.device()).owner_full_access).toBeNull();
  // rerunning the freeze keeps the first publication and completes the enumeration
  const first = await retirement().frozenAt();
  const again = await retirement().freeze("operator");
  expect(again).toMatchObject({ frozenAt: first, stable: true });
  expect((await retirement().freezeState()).enumeratedAt).toBeInstanceOf(Date);
});

it("refuses on a replica whose permission configuration is not current", async () => {
  const f = await fixture();
  const row = await db
    .selectFrom("permission_config_publication")
    .selectAll()
    .executeTakeFirstOrThrow();
  await db
    .updateTable("permission_config_publication")
    .set({ fingerprint: "0".repeat(64) })
    .execute();
  try {
    await expect(snapshots().snapshotAll()).rejects.toThrow(/current permission configuration/);
    expect((await f.device()).owner_full_access).toBeNull();
  } finally {
    await db
      .updateTable("permission_config_publication")
      .set({ fingerprint: row.fingerprint })
      .execute();
  }
});

it("snapshots every live cloud device; a narrowing publishes once; a rerun publishes nothing", async () => {
  // devices left by the earlier cases are snapshotted here too: the driver covers every one
  const plain = await fixture();
  const strict = await fixture({ instance: STRICT });
  const unknown = await fixture({ instance: null });
  const local = await fixture({ source: "local" });
  const deleted = await fixture({ deleted: true });

  const run = await snapshots().snapshotAll();
  const state = (id: string) => run.results.find((r) => r.deviceId === id)?.state;
  expect(state(plain.deviceId)).toBe("unprobed");
  expect(state(strict.deviceId)).toBe("bound");
  expect(state(unknown.deviceId)).toBe("reconcile-required");
  expect(state(local.deviceId)).toBeUndefined();
  expect(state(deleted.deviceId)).toBeUndefined();
  expect(run.failed).toEqual([]);
  expect(run.pending).toBe(0);
  expect(run.reconcileRequired).toEqual([unknown.deviceId]);

  // the narrowing (Full -> not Full) went through the device ceiling writer: consent reset
  expect(await strict.root()).toBe("approve-for-me");
  expect(await strict.epoch()).toBe(1);
  expect(await plain.root()).toBe("full-access");
  // the unreconciled device keeps its marker
  expect((await unknown.device()).permission_reconcile_required).toBe(true);
  expect((await local.device()).owner_full_access).toBeNull();
  expect((await deleted.device()).owner_full_access).toBeNull();

  const rerun = await snapshots().snapshotAll();
  expect(rerun).toMatchObject({ results: [], failed: [], pending: 0 });
  expect(rerun.reconcileRequired).toEqual([unknown.deviceId]);
  expect(await strict.epoch()).toBe(1);
  expect((await unknown.device()).permission_reconcile_required).toBe(true);
});

it("waits for the lifecycle lease; a device it cannot lease stays pending for the next run", async () => {
  const busy = await fixture({ instance: STRICT });
  const lease = await k.app
    .get(SandboxLeases)
    .acquireExclusive(busy.deviceId, AbortSignal.timeout(10_000));
  let run: Awaited<ReturnType<CloudPermissionSnapshots["snapshotAll"]>>;
  try {
    run = await snapshots().snapshotAll({ leaseWaitMs: 300 });
  } finally {
    await lease.release();
  }
  expect(run.results).toEqual([]);
  expect(run.failed.map((x) => x.deviceId)).toEqual([busy.deviceId]);
  expect(run.pending).toBe(1);
  expect((await busy.device()).owner_full_access).toBeNull();
  const next = await snapshots().snapshotAll();
  expect(next.results.map((r) => [r.deviceId, r.state])).toEqual([[busy.deviceId, "bound"]]);
  expect(next.pending).toBe(0);
});

it("resumes after a crash mid-run without publishing a device twice", async () => {
  const a = await fixture({ instance: STRICT });
  const b = await fixture({ instance: STRICT });
  const byId = new Map<string, typeof a>([a, b].map((f) => [f.deviceId, f]));
  const ceilings = k.app.get(PermissionCeilingWrites);
  const original = ceilings.publishLocked.bind(ceilings);
  const seen: string[] = [];
  // the process dies inside the second device's transaction, after its narrowing was written
  const spy = vi
    .spyOn(ceilings, "publishLocked")
    .mockImplementation(async (...args: Parameters<typeof original>) => {
      const out = await original(...args);
      seen.push((args[0] as { deviceId: string }).deviceId);
      if (seen.length === 2) throw new Error("simulated crash");
      return out;
    });
  let first: Awaited<ReturnType<typeof fixture>> | undefined;
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const run = await snapshots().snapshotAll();
    first = byId.get(seen[0] as string);
    second = byId.get(seen[1] as string);
    expect(run.results.map((r) => r.deviceId)).toEqual([first?.deviceId]);
    expect(run.failed.map((x) => x.deviceId)).toEqual([second?.deviceId]);
  } finally {
    spy.mockRestore();
  }
  // the second device's transaction rolled back whole: no snapshot, no epoch, consent kept
  expect((await second?.device())?.owner_full_access).toBeNull();
  expect(await second?.epoch()).toBe(0);
  expect(await second?.root()).toBe("full-access");
  expect(await first?.epoch()).toBe(1);

  const resumed = await snapshots().snapshotAll();
  expect(resumed.results.map((r) => r.deviceId)).toEqual([second?.deviceId]);
  expect(await first?.epoch()).toBe(1);
  expect(await second?.epoch()).toBe(1);
  expect(await second?.root()).toBe("approve-for-me");
});
