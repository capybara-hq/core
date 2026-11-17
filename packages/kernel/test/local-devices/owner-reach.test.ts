import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS, type DeviceOwnerCeilingV3 } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfileStore } from "../../src/conversations/permission-profile-store.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DevicePatchBody, DevicePolicyBody } from "../../src/devices/dto.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DevicePolicyService } from "../../src/local-devices/device-policy.service.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { OwnerReports } from "../../src/local-devices/owner-reports.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { stagedHello } from "./fake-machine.js";

/**
 * Permission runtime cutover B2: authenticated owner reports and independent project reach, through
 * the real writer (OwnerReports, the v3 hello) and the real readers (preview, browse admission,
 * selected-project binding, Full consent and the device read view).
 */
let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
});

const OUTSIDE = "/home/owner/proj";
const report = (
  sequence: number,
  fullAccess: boolean,
  restrictedProjectReach: "workspace" | "os-user",
  restrictedAllowedDomains: string[] = [],
  revision = `rev-${sequence}`,
): DeviceOwnerCeilingV3 => ({
  version: 2,
  revision,
  sequence,
  fullAccess,
  restrictedProjectReach,
  restrictedAllowedDomains,
});

async function fixture() {
  const f = await permissionFixture(k, raw);
  const machine = await f.db
    .selectFrom("device_machines")
    .select("id")
    .where("device_id", "=", f.deviceId)
    .executeTakeFirstOrThrow();
  await f.db
    .insertInto("device_projects")
    .values({ device_id: f.deviceId, name: "outside", path: OUTSIDE, created_by: f.accountId })
    .execute();
  const facts = k.app.get(PermissionFacts);
  const record = (r: DeviceOwnerCeilingV3) =>
    k.app.get(OwnerReports).record(machine.id, r, { connectionId: "c1", via: "hello" });
  const browse = () =>
    k.app
      .get(SandboxOperationAuthority)
      .resolveBrowse(
        { orgId: f.orgId, deviceId: f.deviceId, accountId: f.accountId },
        new AbortController().signal,
      );
  const bindOutside = () =>
    facts.resolveProjectForBinding(f.orgId, f.deviceId, f.accountId, "outside");
  const preview = () => facts.preview(f.orgId, f.accountId, f.deviceId);
  const view = async () =>
    (await k.app.get(DevicesService).get(f.orgId, f.accountId, f.deviceId)).ownerCeiling;
  const profileView = async () =>
    facts.view(
      f.orgId,
      f.accountId,
      await k.app.get(PermissionProfileStore).readOwnedRoot(f.orgId, f.conversationId, f.accountId),
    );
  const consentFull = async () => {
    const p = await facts.scope(f.orgId, f.deviceId, null, null);
    if (!p.scopeRevision) throw new Error("no scope");
    const root = await k.app
      .get(PermissionProfileStore)
      .readOwnedRoot(f.orgId, f.conversationId, f.accountId);
    await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile: "full-access",
      consentScopeRevision: p.scopeRevision,
      expectedRevision: root.permission_revision,
    });
  };
  return {
    ...f,
    machineId: machine.id,
    record,
    browse,
    bindOutside,
    preview,
    view,
    profileView,
    consentFull,
  };
}

describe("all four owner combinations over authenticated reports", () => {
  for (const [fullAccess, reach] of [
    [true, "os-user"],
    [true, "workspace"],
    [false, "os-user"],
    [false, "workspace"],
  ] as const) {
    it(`fullAccess ${fullAccess} / reach ${reach}`, async () => {
      const f = await fixture();
      expect(await f.record(report(1, fullAccess, reach))).toBe("recorded");
      const p = await f.preview();
      // Full execution follows Full permission alone; broad restricted reach follows the reach
      expect(p.fullAccessCeiling).toBe(fullAccess);
      expect(p.broadProjectReach).toBe(reach === "os-user");
      expect((await f.browse()).readRoots).toEqual(reach === "os-user" ? ["/"] : ["/work"]);
      if (reach === "os-user")
        expect(await f.bindOutside()).toEqual({ name: "outside", path: OUTSIDE });
      else
        await expect(f.bindOutside()).rejects.toMatchObject({
          code: "device.project_outside_mode",
        });
      expect(await f.view()).toMatchObject({
        state: "report",
        fullAccess,
        restrictedProjectReach: reach,
        sequence: 1,
        revision: "rev-1",
      });
    });
  }

  it("a platform or org that turns Full off narrows reach to the workspace; no report overrides it", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user"));
    await k.app.get(OrgSettingsService).update(f.orgId, { fullAccess: "off" }, f.accountId);
    const p = await f.preview();
    expect(p.fullAccessCeiling).toBe(false);
    expect(p.broadProjectReach).toBe(false);
    expect((await f.browse()).readRoots).toEqual(["/work"]);
    await expect(f.bindOutside()).rejects.toMatchObject({ code: "device.project_outside_mode" });
    await f.record(report(2, true, "os-user", ["a.test"]));
    expect((await f.preview()).broadProjectReach).toBe(false);
  });
});

describe("stale, missing and out-of-order reports", () => {
  it("a lower sequence or the same sequence with other bytes blocks new authority until a current report", async () => {
    const f = await fixture();
    expect(await f.record(report(5, true, "os-user"))).toBe("recorded");
    expect(await f.record(report(5, true, "os-user"))).toBe("same");
    expect(await f.record(report(3, true, "os-user"))).toBe("stale");
    expect(await f.view()).toMatchObject({ state: "blocked", fullAccess: false, stale: true });
    await expect(f.browse()).rejects.toMatchObject({ code: "device.owner_report_stale" });
    expect((await f.preview()).fullAccessCeiling).toBe(false);
    // the current report again clears the block
    expect(await f.record(report(5, true, "os-user"))).toBe("same");
    expect((await f.browse()).readRoots).toEqual(["/"]);
    expect(await f.record(report(5, false, "os-user"))).toBe("conflict");
    await expect(f.browse()).rejects.toMatchObject({ code: "device.owner_report_stale" });
    expect(await f.record(report(6, false, "os-user"))).toBe("recorded");
    expect((await f.browse()).readRoots).toEqual(["/"]);
  });

  it("a missing report never infers Full or outside reach; a malformed one is refused", async () => {
    const f = await fixture();
    await f.db
      .updateTable("device_machines")
      .set({ local_policy: null })
      .where("id", "=", f.machineId)
      .execute();
    expect(await f.view()).toMatchObject({ state: "missing", fullAccess: false });
    expect((await f.preview()).broadProjectReach).toBe(false);
    await expect(
      f.record({ ...report(1, true, "os-user"), restrictedProjectReach: "home" } as never),
    ).rejects.toThrow();
  });

  it("a new machine credential never adopts the old machine's sequence", async () => {
    const f = await fixture();
    await f.record(report(9, true, "os-user"));
    await f.db
      .updateTable("device_machines")
      .set({ revoked_at: new Date() })
      .where("id", "=", f.machineId)
      .execute();
    const fresh = await f.db
      .insertInto("device_machines")
      .values({
        org_id: f.orgId,
        device_id: f.deviceId,
        account_id: f.accountId,
        credential_hash: randomUUID(),
        name: "Laptop",
        os: "darwin",
        arch: "arm64",
        features: ["mode", "projects"],
        roots: JSON.stringify({ workspace: "/work" }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(await f.view()).toMatchObject({ state: "missing" });
    expect(
      await k.app
        .get(OwnerReports)
        .record(fresh.id, report(0, false, "workspace"), { connectionId: "c2", via: "hello" }),
    ).toBe("recorded");
    // the revoked machine's report can no longer be written
    expect(await f.record(report(10, true, "os-user"))).toBe("revoked");
  });
});

describe("reordered carriers (fix round 1)", () => {
  it("I2: a lower sequence from a policy frame, answer or bind is ignored, never blocks", async () => {
    const f = await fixture();
    expect(await f.record(report(5, true, "os-user"))).toBe("recorded");
    for (const via of ["policy", "policy-result", "bind"] as const)
      expect(
        await k.app
          .get(OwnerReports)
          .record(f.machineId, report(4, false, "workspace"), { connectionId: "c1", via }),
      ).toBe("stale");
    expect(await f.view()).toMatchObject({ state: "report", fullAccess: true, sequence: 5 });
    expect((await f.browse()).readRoots).toEqual(["/"]);
    // a late policy answer with an older sequence still settles its op as applied
    await f.db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: JSON.stringify([
          {
            id: "op-late",
            add: [],
            remove: [],
            source: { accountId: f.accountId, via: "web", approvalId: null },
            status: "sent",
            sentAt: Date.now(),
            resolveAt: Date.now() + 60_000,
            until: Date.now() + 3_600_000,
          },
        ]),
      })
      .where("id", "=", f.machineId)
      .execute();
    const out = await k.app.get(TransactionHost).run(() =>
      k.app.get(DevicePolicyService).settleIn(
        { machineId: f.machineId, opId: "op-late" },
        {
          outcome: "applied",
          policy: { mode: "auto", allowedDomains: [] },
          ownerCeiling: report(3, true, "os-user"),
        },
      ),
    );
    expect(out).toMatchObject({ applied: true });
    expect(await f.view()).toMatchObject({ state: "report", sequence: 5 });
  });

  it("I1: unblocking with a higher report and the same Full keeps Full consent and audits nothing", async () => {
    const f = await fixture();
    await f.record(report(5, true, "os-user"));
    await f.consentFull();
    expect(await f.record(report(4, true, "os-user"))).toBe("stale");
    expect(await f.view()).toMatchObject({ state: "blocked" });
    expect(await f.record(report(6, true, "os-user"))).toBe("recorded");
    expect((await f.profileView()).profile).toBe("full-access");
    const audits = await f.db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "device.owner_ceiling_changed")
      .execute();
    expect(audits).toEqual([]);
  });

  it("M4: every carrier records the authenticated connection", async () => {
    const f = await fixture();
    await k.app
      .get(OwnerReports)
      .record(f.machineId, report(1, true, "os-user"), { connectionId: "conn-9", via: "bind" });
    const row = await f.db
      .selectFrom("device_machines")
      .select("owner_report")
      .where("id", "=", f.machineId)
      .executeTakeFirstOrThrow();
    expect(row.owner_report).toMatchObject({ connectionId: "conn-9", via: "bind" });
  });
});

describe("Full consent and revocation follow only actual Full changes", () => {
  it("restricted-only changes keep Full consent; removing Full resets it; widening needs fresh consent", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user", ["a.test"]));
    await f.consentFull();
    expect((await f.profileView()).profile).toBe("full-access");
    // reach and domains only: Full consent stays
    await f.record(report(2, true, "workspace", []));
    expect((await f.profileView()).profile).toBe("full-access");
    // a new revision with the same facts publishes nothing
    await f.record(report(3, true, "workspace", [], "rev-touched"));
    expect((await f.profileView()).profile).toBe("full-access");
    // Full removed: consent is reset
    await f.record(report(4, false, "workspace"));
    expect((await f.profileView()).profile).toBe("approve-for-me");
    // widening back is not the old consent
    await f.record(report(5, true, "workspace"));
    const v = await f.profileView();
    expect(v.profile).not.toBe("full-access");
  });

  it("a disconnected owner narrowing arrives with the reconnect hello and resets Full", async () => {
    const f = await fixture();
    const roots = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
    await f.db
      .updateTable("device_machines")
      .set({ roots: JSON.stringify(roots) })
      .where("id", "=", f.machineId)
      .execute();
    await f.record(report(1, true, "os-user"));
    await f.consentFull();
    // the owner narrowed on the machine while it was offline; it reconnects with a newer report
    const hello = {
      ...stagedHello(),
      roots,
      ownerCeiling: report(2, false, "os-user"),
    };
    await k.app.get(MachinesService).recordHelloV3(f.machineId, hello, "c-reconnect");
    expect(await f.view()).toMatchObject({ fullAccess: false, restrictedProjectReach: "os-user" });
    expect((await f.profileView()).profile).toBe("approve-for-me");
    // a stale report on a reconnect blocks instead of reverting
    await k.app
      .get(MachinesService)
      .recordHelloV3(f.machineId, { ...hello, ownerCeiling: report(1, true, "os-user") }, "c-old");
    await expect(f.browse()).rejects.toMatchObject({ code: "device.owner_report_stale" });
  });
});

describe("web writes only narrow", () => {
  it("the local policy route refuses any widening; narrowing needs an owner-reporting program", async () => {
    for (const ownerCeiling of [
      { fullAccess: true },
      { restrictedProjectReach: "os-user" },
      { fullAccess: false, extra: 1 },
      {},
    ])
      expect(DevicePolicyBody.safeParse({ ownerCeiling }).success).toBe(false);
    expect(DevicePolicyBody.safeParse({ ownerCeiling: { fullAccess: false } }).success).toBe(true);
    const f = await fixture();
    // a protocol 2 program cannot express it: nothing is sent
    await f.db
      .updateTable("device_machines")
      .set({ features: ["mode", "projects", "policyOp", "policyOpId"] })
      .where("id", "=", f.machineId)
      .execute();
    vi.spyOn(k.app.get(LocalDeviceRelay), "holderLive").mockResolvedValue(true);
    const call = vi.spyOn(k.app.get(LocalDeviceRelay), "call");
    await expect(
      k.app
        .get(DevicesService)
        .changePolicy(f.orgId, { id: f.accountId, displayName: "Owner" }, f.deviceId, {
          ownerCeiling: { fullAccess: false },
        }),
    ).rejects.toMatchObject({ code: "device.policy_unsupported", message: /ceiling set/ });
    expect(call).not.toHaveBeenCalled();
  });

  it("an applied staged answer is accepted only once its owner report is committed", async () => {
    const f = await fixture();
    await f.record(report(4, true, "os-user"));
    const policies = k.app.get(DevicePolicyService);
    await f.db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: JSON.stringify([
          {
            id: "op-1",
            add: [],
            remove: [],
            source: { accountId: f.accountId, via: "web", approvalId: null },
            status: "sent",
            sentAt: Date.now(),
            resolveAt: Date.now() + 60_000,
            until: Date.now() + 3_600_000,
          },
        ]),
      })
      .where("id", "=", f.machineId)
      .execute();
    const settle = (ownerCeiling: DeviceOwnerCeilingV3) =>
      k.app.get(TransactionHost).run(() =>
        policies.settleIn(
          { machineId: f.machineId, opId: "op-1" },
          {
            outcome: "applied",
            policy: { mode: "sandbox", allowedDomains: [] },
            ownerCeiling,
          },
        ),
      );
    // a conflicting report (same sequence, other bytes) is not accepted as applied
    expect(await settle(report(4, false, "os-user"))).toMatchObject({ applied: false });
    expect(await f.view()).toMatchObject({ state: "blocked" });
    expect(await settle(report(5, false, "os-user"))).toMatchObject({ applied: true });
    expect(await f.view()).toMatchObject({ state: "report", fullAccess: false, sequence: 5 });
  });
});

describe("cloud owner ceiling PATCH", () => {
  async function cloud() {
    const f = await fixture();
    const id = randomUUID();
    await f.db
      .insertInto("devices")
      .values({
        id,
        org_id: f.orgId,
        owner_kind: "personal",
        owner_account_id: f.accountId,
        source: "cloud",
        provider: "@permission-policy-test",
        name: "Cloud",
        owner_full_access: false,
        outer_network: JSON.stringify({ kind: "allowlist", hosts: ["a.test"] }),
      })
      .execute();
    const devices = k.app.get(DevicesService);
    const patch = (p: Parameters<DevicesService["update"]>[3]) =>
      devices.update(f.orgId, f.accountId, id, p);
    const row = () =>
      f.db
        .selectFrom("devices")
        .select(["owner_full_access", "outer_network"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    return { f, id, patch, row };
  }

  it("widening needs confirmation and an allowing platform and org; it never opens the outer network", async () => {
    const c = await cloud();
    expect(DevicePatchBody.safeParse({ ownerCeiling: { fullAccess: "yes" } }).success).toBe(false);
    await expect(c.patch({ ownerCeiling: { fullAccess: true } })).rejects.toMatchObject({
      code: "device.owner_ceiling_confirmation_required",
    });
    expect((await c.row()).owner_full_access).toBe(false);
    const view = await c.patch({ ownerCeiling: { fullAccess: true }, confirmWidening: true });
    expect(view.ownerCeiling).toMatchObject({ state: "cloud", fullAccess: true });
    expect(await c.row()).toEqual({
      owner_full_access: true,
      outer_network: { kind: "allowlist", hosts: ["a.test"] },
    });
    await c.patch({ ownerCeiling: { fullAccess: false } });
    expect((await c.row()).owner_full_access).toBe(false);
    await k.app.get(OrgSettingsService).update(c.f.orgId, { fullAccess: "off" }, c.f.accountId);
    await expect(
      c.patch({ ownerCeiling: { fullAccess: true }, confirmWidening: true }),
    ).rejects.toMatchObject({ code: "device.full_access_not_allowed" });
  });

  it("I3: a device B1 has not snapshotted is refused, never widened or pre-empted", async () => {
    const c = await cloud();
    await c.f.db
      .updateTable("devices")
      .set({ owner_full_access: null, outer_network: null, mode: "sandbox" })
      .where("id", "=", c.id)
      .execute();
    for (const p of [
      { ownerCeiling: { fullAccess: true }, confirmWidening: true as const },
      { ownerCeiling: { fullAccess: false } },
    ])
      await expect(c.patch(p)).rejects.toMatchObject({
        code: "device.permission_reconcile_required",
      });
    expect(
      await c.f.db
        .selectFrom("devices")
        .select(["owner_full_access", "outer_network", "mode"])
        .where("id", "=", c.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ owner_full_access: null, outer_network: null, mode: "sandbox" });
  });

  it("M3: widening is refused when the provider cannot run Full", async () => {
    const c = await cloud();
    // a provider without permission-scoped operations cannot enforce Full
    await c.f.db
      .updateTable("devices")
      .set({ provider: "@no-permission-provider" })
      .where("id", "=", c.id)
      .execute();
    await expect(
      c.patch({ ownerCeiling: { fullAccess: true }, confirmWidening: true }),
    ).rejects.toMatchObject({ code: "device.full_access_not_allowed" });
    expect((await c.row()).owner_full_access).toBe(false);
  });

  it("a local device's owner ceiling is not set by the PATCH", async () => {
    const f = await fixture();
    await expect(
      k.app
        .get(DevicesService)
        .update(f.orgId, f.accountId, f.deviceId, { ownerCeiling: { fullAccess: false } }),
    ).rejects.toMatchObject({ code: "device.mode_on_device" });
  });
});
