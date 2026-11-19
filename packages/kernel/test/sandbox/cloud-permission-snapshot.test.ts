import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { CloudPermissionSnapshots } from "../../src/sandbox/cloud-permission-snapshot.js";
import { runSandboxResetFiles } from "../../src/sandbox/jobs.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { readRuntimeReport } from "../../src/sandbox/permission-runtime-reports.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { seedCloudEvidence, seedCloudInstance } from "../helpers/installed-evidence.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * B1: the cloud per-device snapshot writer. It takes the device's exclusive lifecycle lease, then
 * the device authority write lock, and records the owner ceiling and outer network computed from
 * the OLD effective authority; unknown, stale, wider or pending applied limits block admission.
 */
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let db: KernelDb;
const log = createLogger("error", { write: () => {} });
const PROVIDER = "@b1-snapshot-test";

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
      sandbox: { limits: { egress: "allowlist", allowHosts: ["a.example", "b.example"] } },
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
beforeEach(async () => {
  await db.deleteFrom("deployment_settings").where("key", "=", "devicesOutsideSandbox").execute();
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function fixture(
  opts: { settings?: Record<string, unknown>; mode?: "sandbox"; instance?: unknown } = {},
) {
  const accountId = randomUUID(),
    orgId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID(),
    deviceId = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "B1", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({
      id: orgId,
      slug: orgId,
      name: "B1",
      created_by: accountId,
      settings: JSON.stringify(opts.settings ?? {}),
    })
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
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      source: "cloud",
      provider: PROVIDER,
      mode: opts.mode ?? null,
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
    })
    .execute();
  const device = () =>
    db
      .selectFrom("devices")
      .select([
        "owner_full_access",
        "outer_network",
        "permission_migration",
        "permission_reconcile_required",
      ])
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
  const ctx = {
    orgId,
    deviceId,
    holderConversationId: conversationId,
    actor: { accountId, conversationId },
  };
  const admit = () =>
    k.app
      .get(SandboxOperationAuthority)
      .resolve(ctx, "exec", new AbortController().signal)
      .then(
        () => "admitted",
        // an unprobed or unsupported device's refusal is its context reason (B-16)
        (e: unknown) =>
          (e as { code?: string }).code === "forbidden"
            ? (e as Error).message
            : ((e as { code?: string }).code ?? String(e)),
      );
  // the lifecycle's create: a running instance of the wanted limits with its cloud evidence (B-15)
  const provision = () =>
    seedCloudInstance(k, { orgId, deviceId, provider: PROVIDER, version: "test" });
  const root = async () =>
    (
      await db
        .selectFrom("conversations")
        .select(["permission_profile", "permission_revision"])
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow()
    ).permission_profile;
  const fullRoot = () =>
    db
      .updateTable("conversations")
      .set({
        permission_profile: "full-access",
        permission_consent: JSON.stringify({ deviceId, scopeRevision: "x" }),
      })
      .where("id", "=", conversationId)
      .execute();
  return {
    orgId,
    deviceId,
    accountId,
    conversationId,
    ctx,
    device,
    admit,
    provision,
    root,
    fullRoot,
  };
}
const snapshots = () => k.app.get(CloudPermissionSnapshots);
const policy = (f: { orgId: string; deviceId: string }) =>
  k.app.get(PermissionFacts).devicePolicy({ orgId: f.orgId, deviceId: f.deviceId });
const OPEN = { kind: "open-public", hosts: [] };
/** A cloud device without current installed evidence (no instance yet, or none recorded). */
const UNPROBED = "Checked when this device starts";

it("a device without an instance stores the desired authority, unprobed, never blocked", async () => {
  const f = await fixture();
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "unprobed" });
  expect(await f.device()).toMatchObject({
    owner_full_access: true,
    outer_network: OPEN,
    permission_reconcile_required: false,
    permission_migration: { from: "auto-mode", old: { mode: "auto", network: OPEN } },
  });
  // never blocked: without an instance it is honestly unprobed, and its first use provisions it
  expect(await f.admit()).toBe(UNPROBED);
  await f.provision();
  expect(await f.admit()).toBe("admitted");
});

it("exactly applied limits bind the snapshot to the instance generation", async () => {
  const applied = {
    mode: "sandbox",
    network: { kind: "allowlist", hosts: ["b.example", "a.example"] },
  };
  const f = await fixture({
    settings: { deviceNetwork: { ceiling: "allowlist" } },
    mode: "sandbox",
    instance: applied,
  });
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "bound" });
  expect(await f.device()).toMatchObject({
    owner_full_access: false,
    outer_network: { kind: "allowlist", hosts: ["a.example", "b.example"] },
    permission_reconcile_required: false,
  });
  // false stays explicit after the org widens later: no Full, the snapshot network caps it
  await k.app.get(OrgSettingsService).update(f.orgId, { deviceNetwork: null }, f.accountId);
  expect(await policy(f)).toMatchObject({
    mode: "sandbox",
    network: { kind: "allowlist", hosts: ["a.example", "b.example"] },
  });
});

it.each([
  ["unknown", null],
  [
    "stale host set",
    { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.example", "c.example"] } },
  ],
  [
    "a pending reset",
    {
      mode: "sandbox",
      network: { kind: "allowlist", hosts: ["a.example", "b.example"] },
      unapplied: { mode: "auto", network: OPEN },
    },
  ],
])(
  "%s applied limits block admission until a lifecycle action establishes them",
  async (_, instance) => {
    const f = await fixture({
      settings: { deviceNetwork: { ceiling: "allowlist" } },
      mode: "sandbox",
      instance,
    });
    expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({
      state: "reconcile-required",
    });
    expect((await f.device()).permission_reconcile_required).toBe(true);
    expect(await f.admit()).toBe("device.permission_reconcile_required");
    // nothing established yet: reconciling keeps the block and names the action
    expect(await snapshots().reconcile(f.orgId, f.deviceId)).toMatchObject({
      state: "reconcile-required",
      action: "reset-files",
    });
    // the files reset (no instance, no file system): the next create applies the exact limits
    await db
      .updateTable("device_instances")
      .set({
        handle: null,
        status: "none",
        fs_status: "none",
        fs_handle: null,
        instance_limits: null,
      })
      .where("device_id", "=", f.deviceId)
      .execute();
    expect(await snapshots().reconcile(f.orgId, f.deviceId)).toMatchObject({ state: "unprobed" });
    // no longer blocked: unprobed until the next create applies the exact limits and records them
    expect(await f.admit()).toBe(UNPROBED);
    await f.provision();
    expect(await f.admit()).toBe("admitted");
  },
);

it("a stricter applied instance is never widened to the inferred default", async () => {
  const strict = { mode: "sandbox", network: { kind: "allowlist", hosts: [] } };
  const f = await fixture({ instance: strict });
  await f.fullRoot();
  const epoch = () =>
    db
      .selectFrom("permission_authority_epochs")
      .select(["revision", "full_revision"])
      .where("kind", "=", "device")
      .where("id", "=", f.deviceId)
      .executeTakeFirst();
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "bound" });
  // the narrowing is a real authority change: it publishes through the device ceiling writer
  expect(await f.root()).toBe("approve-for-me");
  expect(await epoch()).toMatchObject({ revision: 1, full_revision: 1 });
  expect(await f.device()).toMatchObject({
    owner_full_access: false,
    outer_network: { kind: "allowlist", hosts: [] },
  });
  // an empty snapshot allowlist ran closed: the device's own network is closed (`none`), which
  // the instance gets as an empty allowlist (approval-only profiles design, "Migration")
  expect(await policy(f)).toMatchObject({
    mode: "sandbox",
    network: { kind: "allowlist", hosts: [] },
  });
});

it("the snapshot is written once; a later run keeps it whatever changed since", async () => {
  const f = await fixture();
  await snapshots().snapshot(f.orgId, f.deviceId);
  await k.app.get(OrgSettingsService).update(f.orgId, { outsideSandbox: "off" }, f.accountId);
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "existing" });
  expect((await f.device()).owner_full_access).toBe(true);
  // the org's off still cuts the effective mode; the owner ceiling is independent of it
  expect((await policy(f)).mode).toBe("sandbox");
});

it("a stored platform off over the default is part of the old effective authority", async () => {
  await db
    .insertInto("deployment_settings")
    .values({ key: "devicesOutsideSandbox", value: JSON.stringify({ permission: "off" }) })
    .execute();
  const f = await fixture();
  await snapshots().snapshot(f.orgId, f.deviceId);
  expect(await f.device()).toMatchObject({ owner_full_access: false, outer_network: OPEN });
});

it("after a snapshot the old switch narrows the owner ceiling, and clearing it never widens", async () => {
  const f = await fixture();
  await snapshots().snapshot(f.orgId, f.deviceId);
  const devices = k.app.get(DevicesService);
  await devices.update(f.orgId, f.accountId, f.deviceId, { mode: "sandbox" });
  expect((await f.device()).owner_full_access).toBe(false);
  await devices.update(f.orgId, f.accountId, f.deviceId, { mode: null });
  expect((await f.device()).owner_full_access).toBe(false);
  expect((await policy(f)).mode).toBe("sandbox");
});

it("the file reset job reconciles the device it reset", async () => {
  const f = await fixture({ instance: null });
  await snapshots().snapshot(f.orgId, f.deviceId);
  expect(await f.admit()).toBe("device.permission_reconcile_required");
  const sandbox = {
    resetFileSystem: async (id: string) => {
      await db
        .updateTable("device_instances")
        .set({ handle: null, status: "none", fs_status: "none", fs_handle: null })
        .where("device_id", "=", id)
        .execute();
    },
  };
  await runSandboxResetFiles(sandbox, { data: { deviceId: f.deviceId } }, snapshots());
  expect((await f.device()).permission_reconcile_required).toBe(false);
  expect(await f.admit()).toBe(UNPROBED);
  await f.provision();
  expect(await f.admit()).toBe("admitted");
});

it("a snapshot that changes nothing publishes nothing", async () => {
  const f = await fixture();
  await f.fullRoot();
  await snapshots().snapshot(f.orgId, f.deviceId);
  expect(await f.root()).toBe("full-access");
});

it("a create that may have acted (creating, no handle) is reconcile-required, not unprobed", async () => {
  const f = await fixture({ instance: null });
  await db
    .updateTable("device_instances")
    .set({ status: "creating", handle: null, fs_status: "none", fs_handle: null })
    .where("device_id", "=", f.deviceId)
    .execute();
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({
    state: "reconcile-required",
  });
});

it("refuses to snapshot on a replica whose permission configuration is not current", async () => {
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
    await expect(snapshots().snapshot(f.orgId, f.deviceId)).rejects.toThrow(
      /current permission configuration/,
    );
    expect((await f.device()).owner_full_access).toBeNull();
  } finally {
    await db
      .updateTable("permission_config_publication")
      .set({ fingerprint: row.fingerprint })
      .execute();
  }
});

it("a snapshot narrowed to an allowlist revokes execution scopes outside any allowlist", async () => {
  const f = await fixture({
    instance: { mode: "auto", network: { kind: "allowlist", hosts: ["a.example"] } },
  });
  await seedCloudEvidence(k, {
    orgId: f.orgId,
    deviceId: f.deviceId,
    provider: PROVIDER,
    version: "test",
  });
  const scope = await k.app
    .get(SandboxOperationAuthority)
    .resolve(f.ctx, "exec", new AbortController().signal);
  const insert = async (network: unknown) => {
    const operationId = randomUUID();
    await db
      .insertInto("sandbox_operation_intents")
      .values({
        operation_id: operationId,
        org_id: f.orgId,
        account_id: f.accountId,
        device_id: f.deviceId,
        root_conversation_id: f.conversationId,
        conversation_id: f.conversationId,
        run_id: null,
        call_id: null,
        ordinal: 0,
        method: "exec",
        input_hash: "a".repeat(64),
        admission_hash: "b".repeat(64),
        input: "{}",
        scope: JSON.stringify({ ...scope, operationId, network }),
        epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
        provider: PROVIDER,
        provider_version: "test",
        instance_generation: "test",
        deadline: new Date(Date.now() + 30_000),
        retain_until: new Date(Date.now() + 60_000),
        state: "admitted",
        execution_id: randomUUID(),
      })
      .execute();
    return operationId;
  };
  const environment = await insert({ kind: "environment" });
  const covered = await insert({ kind: "allowlist", hosts: ["a.example"] });
  const none = await insert({ kind: "none" });
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "bound" });
  const states = await db
    .selectFrom("sandbox_operation_intents")
    .select(["operation_id", "state"])
    .where("operation_id", "in", [environment, covered, none])
    .execute();
  const of = (id: string) => states.find((r) => r.operation_id === id)?.state;
  expect(of(environment)).toBe("revoked");
  expect(of(covered)).toBe("admitted");
  expect(of(none)).toBe("admitted");
});

it("B-12: a provider instance narrower than the snapshot keeps the narrower boundary on reconcile (intersection), never widened", async () => {
  // snapshotted open with Full while the applied limits were unknown: blocked
  const f = await fixture({ instance: null });
  await f.fullRoot();
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({
    state: "reconcile-required",
  });
  expect(await f.device()).toMatchObject({ owner_full_access: true, outer_network: OPEN });
  // the provider's instance turns out to run narrower than the snapshot in every dimension
  const strict = { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.example"] } };
  await db
    .updateTable("device_instances")
    .set({ instance_limits: JSON.stringify(strict) })
    .where("device_id", "=", f.deviceId)
    .execute();
  // reconciling keeps the narrower boundary: the authority is cut to it (a real narrowing,
  // published through the device ceiling writer), which then is exactly what the instance runs
  expect(await snapshots().reconcile(f.orgId, f.deviceId)).toMatchObject({ state: "bound" });
  expect(await f.device()).toMatchObject({
    owner_full_access: false,
    outer_network: { kind: "allowlist", hosts: ["a.example"] },
    permission_reconcile_required: false,
  });
  expect(await f.root()).toBe("approve-for-me");
  expect(await policy(f)).toMatchObject({
    mode: "sandbox",
    network: { kind: "allowlist", hosts: ["a.example"] },
  });
});

it("B-12: applied limits wider in one dimension are narrowed in the other and name the update target, never wider than the instance", async () => {
  // old sandbox-open (false/open), an unknown instance first
  const f = await fixture({ mode: "sandbox", instance: null });
  await snapshots().snapshot(f.orgId, f.deviceId);
  // the instance runs auto (wider than the sandbox ceiling) on one host (narrower than open)
  await db
    .updateTable("device_instances")
    .set({
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "allowlist", hosts: ["a.example"] },
      }),
    })
    .where("device_id", "=", f.deviceId)
    .execute();
  expect(await snapshots().reconcile(f.orgId, f.deviceId)).toMatchObject({
    state: "reconcile-required",
    target: { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.example"] } },
  });
  expect(await f.device()).toMatchObject({
    owner_full_access: false,
    outer_network: { kind: "allowlist", hosts: ["a.example"] },
    permission_reconcile_required: true,
  });
});

it("B-12: an instance whose applied mode is the OS sandbox reads Full as unsupported (its outer boundary rests on child filters)", async () => {
  const f = await fixture({ instance: { mode: "sandbox", network: OPEN } });
  await seedCloudEvidence(k, {
    orgId: f.orgId,
    deviceId: f.deviceId,
    provider: PROVIDER,
    version: "test",
  });
  const availability = await readRuntimeReport(db.db, f.deviceId, PROVIDER, "test");
  expect(availability).toMatchObject({
    state: "supported",
    report: { outsideSandbox: false, restricted: { network: true } },
  });
  // the same provider report on an instance applied without the OS sandbox keeps Full
  await db
    .updateTable("device_instances")
    .set({ instance_limits: JSON.stringify({ mode: "auto", network: OPEN }) })
    .where("device_id", "=", f.deviceId)
    .execute();
  await seedCloudEvidence(k, {
    orgId: f.orgId,
    deviceId: f.deviceId,
    provider: PROVIDER,
    version: "test",
  });
  expect(await readRuntimeReport(db.db, f.deviceId, PROVIDER, "test")).toMatchObject({
    state: "supported",
    report: { outsideSandbox: true },
  });
});

it("B-12: the recorded limits of a destroyed instance never narrow the authority; a file-system-bound provider's do", async () => {
  const f = await fixture({ instance: null });
  await snapshots().snapshot(f.orgId, f.deviceId);
  // the instance was destroyed; its stale record is left on the row with the files
  const strict = { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.example"] } };
  await db
    .updateTable("device_instances")
    .set({ status: "destroyed", handle: null, instance_limits: JSON.stringify(strict) })
    .where("device_id", "=", f.deviceId)
    .execute();
  expect(await snapshots().reconcile(f.orgId, f.deviceId)).toMatchObject({
    state: "reconcile-required",
  });
  expect(await f.device()).toMatchObject({ owner_full_access: true, outer_network: OPEN });
  // a provider whose limits are fixed at its file system: the record is what the files enforce
  const providers = k.app.get(SandboxProviders);
  const entry = providers.forName(PROVIDER);
  if (!entry) throw new Error("expected the test provider");
  providers.register({
    ...entry,
    impl: Object.assign(Object.create(entry.impl), { limitsApplyAt: "fileSystem" }),
  });
  try {
    await snapshots().reconcile(f.orgId, f.deviceId);
    expect(await f.device()).toMatchObject({
      owner_full_access: false,
      outer_network: { kind: "allowlist", hosts: ["a.example"] },
    });
  } finally {
    providers.register(entry);
  }
});
