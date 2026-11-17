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
import { SandboxProviders } from "../../src/sandbox/providers.js";
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
  await db.deleteFrom("deployment_settings").where("key", "=", "devicesFullAccess").execute();
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
        (e: unknown) => (e as { code?: string }).code ?? String(e),
      );
  return { orgId, deviceId, accountId, device, admit };
}
const snapshots = () => k.app.get(CloudPermissionSnapshots);
const policy = (f: { orgId: string; deviceId: string }) =>
  k.app.get(PermissionFacts).devicePolicy({ orgId: f.orgId, deviceId: f.deviceId });
const OPEN = { kind: "open-public", hosts: [] };

it("a device without an instance stores the desired authority, unprobed, never blocked", async () => {
  const f = await fixture();
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "unprobed" });
  expect(await f.device()).toMatchObject({
    owner_full_access: true,
    outer_network: OPEN,
    permission_reconcile_required: false,
    permission_migration: { from: "auto-mode", old: { mode: "auto", network: OPEN } },
  });
  expect(await f.admit()).toBe("admitted");
});

it("exactly applied limits bind the snapshot to the instance generation", async () => {
  const applied = {
    mode: "sandbox",
    network: { kind: "allowlist", hosts: ["b.example", "a.example"] },
  };
  const f = await fixture({
    settings: { cloudNetwork: { mode: "allowlist" } },
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
  await k.app.get(OrgSettingsService).update(f.orgId, { cloudNetwork: null }, f.accountId);
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
      settings: { cloudNetwork: { mode: "allowlist" } },
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
    expect(await f.admit()).toBe("admitted");
  },
);

it("a stricter applied instance is never widened to the inferred default", async () => {
  const strict = { mode: "sandbox", network: { kind: "allowlist", hosts: [] } };
  const f = await fixture({ instance: strict });
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "bound" });
  expect(await f.device()).toMatchObject({
    owner_full_access: false,
    outer_network: { kind: "allowlist", hosts: [] },
  });
  expect(await policy(f)).toMatchObject({
    mode: "sandbox",
    network: { kind: "allowlist", hosts: [] },
  });
});

it("the snapshot is written once; a later run keeps it whatever changed since", async () => {
  const f = await fixture();
  await snapshots().snapshot(f.orgId, f.deviceId);
  await k.app.get(OrgSettingsService).update(f.orgId, { fullAccess: "off" }, f.accountId);
  expect(await snapshots().snapshot(f.orgId, f.deviceId)).toMatchObject({ state: "existing" });
  expect((await f.device()).owner_full_access).toBe(true);
  // the org's off still cuts the effective mode; the owner ceiling is independent of it
  expect((await policy(f)).mode).toBe("sandbox");
});

it("a stored platform off over the default is part of the old effective authority", async () => {
  await db
    .insertInto("deployment_settings")
    .values({ key: "devicesFullAccess", value: JSON.stringify({ permission: "off" }) })
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
  expect(await f.admit()).toBe("admitted");
});
