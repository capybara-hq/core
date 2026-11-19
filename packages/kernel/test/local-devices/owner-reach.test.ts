import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS, type DeviceOwnerCeiling } from "@capybara-hq/plugin-sdk";
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
import { stagedHello } from "./fake-machine-v3.js";

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
): DeviceOwnerCeiling => ({
  version: 3,
  revision,
  sequence,
  outsideSandbox: fullAccess,
  // as the fixture's stored report: an owner who allows running outside keeps the open network
  network: fullAccess ? "open" : "allowlist",
  restrictedProjectReach,
  allowedDomains: restrictedAllowedDomains,
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
  const record = (r: DeviceOwnerCeiling) =>
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
      expect(p.outsideSandboxCeiling).toBe(fullAccess);
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
        outsideSandbox: fullAccess,
        restrictedProjectReach: reach,
        sequence: 1,
        revision: "rev-1",
      });
    });
  }

  it("a platform or org that turns Full off narrows reach to the workspace; no report overrides it", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user"));
    await k.app.get(OrgSettingsService).update(f.orgId, { outsideSandbox: "off" }, f.accountId);
    const p = await f.preview();
    expect(p.outsideSandboxCeiling).toBe(false);
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
    expect(await f.view()).toMatchObject({ state: "blocked", outsideSandbox: false, stale: true });
    await expect(f.browse()).rejects.toMatchObject({ code: "device.owner_report_stale" });
    expect((await f.preview()).outsideSandboxCeiling).toBe(false);
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
      .set({ owner_report: null })
      .where("id", "=", f.machineId)
      .execute();
    expect(await f.view()).toMatchObject({ state: "missing", outsideSandbox: false });
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
        features: ["projects"],
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

describe("the device view's recent changes", () => {
  it("a machine's ceiling change is listed as made on the machine", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user"));
    await f.record(report(2, false, "workspace"));
    const view = await k.app.get(DevicesService).get(f.orgId, f.accountId, f.deviceId);
    expect(view.sandbox.recent[0]).toMatchObject({
      kind: "ceiling",
      ceiling: {
        from: { outsideSandbox: true, restrictedProjectReach: "os-user" },
        to: { outsideSandbox: false, restrictedProjectReach: "workspace" },
      },
      via: "device",
      outcome: "applied",
    });
    // a local device has no cloud reconcile marker
    expect(view.reconcileRequired).toBe(false);
  });
});

describe("the device view's owner ceiling", () => {
  it("a machine row without a report never infers Full from an older summary, as admission does", async () => {
    const f = await fixture();
    const setOld = (features: string[], localPolicy: unknown) =>
      f.db
        .updateTable("device_machines")
        .set({ owner_report: null, features, local_policy: JSON.stringify(localPolicy) })
        .where("id", "=", f.machineId)
        .execute();
    // protocol 4 has no legacy owner state: an old isolation or mode is ignored, fail closed
    await setOld([], { isolation: "none" });
    expect(await f.view()).toMatchObject({
      state: "missing",
      outsideSandbox: false,
      network: "allowlist",
    });
    await setOld(["networkReport"], { mode: "auto", allowedDomains: [] });
    expect(await f.view()).toMatchObject({ state: "missing", outsideSandbox: false });
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
    expect(await f.view()).toMatchObject({ state: "report", outsideSandbox: true, sequence: 5 });
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
          policy: { allowedDomains: [] },
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
  it("narrowing changes keep Full consent; only a widening needs fresh consent", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user", ["a.test"]));
    await f.consentFull();
    expect((await f.profileView()).profile).toBe("full-access");
    // domains only: Full consent stays
    await f.record(report(2, true, "os-user", []));
    expect((await f.profileView()).profile).toBe("full-access");
    // a new revision with the same facts publishes nothing
    await f.record(report(3, true, "os-user", [], "rev-touched"));
    expect((await f.profileView()).profile).toBe("full-access");
    // a narrower reach and running outside removed are narrowings: the consent still covers them
    await f.record(report(31, true, "workspace", []));
    expect((await f.profileView()).profile).toBe("full-access");
    await f.record(report(32, false, "workspace"));
    expect((await f.profileView()).profile).toBe("full-access");
    // widening back resets it with a recorded profile change: not the old consent
    await f.record(report(33, true, "workspace"));
    const v = await f.profileView();
    expect(v.profile).not.toBe("full-access");
    const changed = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", f.conversationId)
      .where("type", "=", "permission_profile_changed")
      .execute();
    expect(changed.at(-1)?.payload).toMatchObject({ newProfile: "approve-for-me" });
  });

  it("an owner network narrowing publishes, audits, keeps Full consent and revokes open work", async () => {
    const f = await fixture();
    await f.record(report(1, true, "workspace"));
    await f.consentFull();
    expect((await f.profileView()).profile).toBe("full-access");
    const operationId = randomUUID();
    await f.db.insertInto("sandbox_operation_intents").values(openIntent(f, operationId)).execute();
    await f.record({ ...report(2, true, "workspace"), network: "allowlist" });
    // open to allowlist only narrows: the consent still covers it
    expect((await f.profileView()).profile).toBe("full-access");
    const intent = await f.db
      .selectFrom("sandbox_operation_intents")
      .select("state")
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow();
    expect(intent.state).toBe("revoked");
    const audits = await f.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "device.owner_ceiling_changed")
      .execute();
    expect(audits.at(-1)?.detail).toMatchObject({
      from: { network: "open" },
      to: { network: "allowlist" },
    });
  });

  it("an org that turns running outside off keeps the Full consent (a narrowing); admission stays sandboxed", async () => {
    const f = await fixture();
    await f.record(report(1, true, "os-user"));
    await f.consentFull();
    expect((await f.profileView()).profile).toBe("full-access");
    const admit = () =>
      k.app.get(SandboxOperationAuthority).resolve(
        {
          orgId: f.orgId,
          deviceId: f.deviceId,
          holderConversationId: f.conversationId,
          actor: { accountId: f.accountId, conversationId: f.conversationId, runId: f.runId },
        },
        "exec",
        new AbortController().signal,
      );
    // Full access keeps the sandbox: a scoped filesystem, never the device pair
    const full = await admit();
    expect(full).toMatchObject({ profile: "full-access", filesystem: { kind: "scoped" } });
    // the org turns Full off; the machine still reports a Full owner ceiling
    await k.app.get(OrgSettingsService).update(f.orgId, { outsideSandbox: "off" }, f.accountId);
    expect((await f.profileView()).profile).toBe("full-access");
    expect((await f.profileView()).outsideSandboxCeiling).toBe(false);
    const narrowed = await admit();
    expect(narrowed.profile).toBe("full-access");
    expect(narrowed.filesystem.kind).toBe("scoped");
    expect(narrowed.network.kind).not.toBe("environment");
  });

  it("a disconnected owner narrowing arrives with the reconnect hello and keeps Full consent", async () => {
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
    expect(await f.view()).toMatchObject({
      outsideSandbox: false,
      restrictedProjectReach: "os-user",
    });
    expect((await f.profileView()).profile).toBe("full-access");
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
      { outsideSandbox: true },
      { network: "open" },
      { restrictedProjectReach: "os-user" },
      { outsideSandbox: false, extra: 1 },
      { fullAccess: false },
      {},
    ])
      expect(DevicePolicyBody.safeParse({ ownerCeiling }).success).toBe(false);
    for (const ownerCeiling of [{ outsideSandbox: false }, { network: "allowlist" }])
      expect(DevicePolicyBody.safeParse({ ownerCeiling }).success).toBe(true);
    const f = await fixture();
    // a connected program that reports no authenticated owner facts cannot take it: nothing is
    // sent (protocol 2 programs are refused at the upgrade since the activation)
    await f.db
      .updateTable("device_machines")
      .set({ features: ["projects", "policyOp", "policyOpId"], owner_report: null })
      .where("id", "=", f.machineId)
      .execute();
    const relay = k.app.get(LocalDeviceRelay);
    vi.spyOn(relay, "holderLive").mockResolvedValue(true);
    vi.spyOn(relay, "stagedTransport").mockResolvedValue({
      connectionId: "c-1",
      maxFrameBytes: 69632,
    });
    const call = vi.spyOn(relay, "callV3");
    await expect(
      k.app
        .get(DevicesService)
        .changePolicy(f.orgId, { id: f.accountId, displayName: "Owner" }, f.deviceId, {
          ownerCeiling: { outsideSandbox: false },
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
    const settle = (ownerCeiling: DeviceOwnerCeiling) =>
      k.app.get(TransactionHost).run(() =>
        policies.settleIn(
          { machineId: f.machineId, opId: "op-1" },
          {
            outcome: "applied",
            policy: { allowedDomains: [] },
            ownerCeiling,
          },
        ),
      );
    // a conflicting report (same sequence, other bytes) is not accepted as applied
    expect(await settle(report(4, false, "os-user"))).toMatchObject({ applied: false });
    expect(await f.view()).toMatchObject({ state: "blocked" });
    expect(await settle(report(5, false, "os-user"))).toMatchObject({ applied: true });
    expect(await f.view()).toMatchObject({ state: "report", outsideSandbox: false, sequence: 5 });
  });
});

describe("cloud network PATCH (service)", () => {
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
      })
      .execute();
    const devices = k.app.get(DevicesService);
    const patch = (
      p: Parameters<DevicesService["update"]>[3],
      opts: Parameters<DevicesService["update"]>[5] = {},
    ) => devices.update(f.orgId, f.accountId, id, p, undefined, opts);
    const row = () =>
      f.db
        .selectFrom("devices")
        .select(["network_mode", "network_hosts"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    return { f, id, patch, row };
  }

  it("the old cloud Full ceiling and mode switch are gone from the body", () => {
    for (const body of [
      { ownerCeiling: { fullAccess: true } },
      { mode: "sandbox" },
      { confirmWidening: true },
      { network: { mode: "allowlist", hosts: ["a.test"], extra: 1 } },
    ])
      expect(DevicePatchBody.safeParse(body).success).toBe(false);
    expect(DevicePatchBody.safeParse({ network: { mode: null } }).success).toBe(true);
  });

  it("narrow only (the Platform tool): a narrowing applies, a widening is refused and writes nothing", async () => {
    const c = await cloud();
    const view = await c.patch({ network: { mode: "none" } }, { narrowOnly: true });
    expect(view.sandbox).toMatchObject({ network: "none", ownNetwork: "none" });
    for (const network of [
      { mode: "open" as const },
      { mode: null },
      { mode: "allowlist" as const },
    ])
      await expect(c.patch({ network }, { narrowOnly: true })).rejects.toMatchObject({
        code: "device.network_not_allowed",
      });
    expect(await c.row()).toEqual({ network_mode: "none", network_hosts: [] });
    // the owner in a web session may widen again within the ceilings
    expect((await c.patch({ network: { mode: null } })).sandbox.network).toBe("open");
  });

  it("a cloud device has no owner ceiling and never runs outside; the view reports the reconcile marker", async () => {
    const c = await cloud();
    const get = () => k.app.get(DevicesService).get(c.f.orgId, c.f.accountId, c.id);
    let view = await get();
    expect(view.ownerCeiling).toBeNull();
    expect(view.sandbox.outsideSandbox).toBe(false);
    expect(view.reconcileRequired).toBe(false);
    await c.f.db
      .updateTable("devices")
      .set({ permission_reconcile_required: true })
      .where("id", "=", c.id)
      .execute();
    view = await get();
    expect(view.reconcileRequired).toBe(true);
  });

  it("a local device's network is not set by the PATCH", async () => {
    const f = await fixture();
    await expect(
      k.app
        .get(DevicesService)
        .update(f.orgId, f.accountId, f.deviceId, { network: { mode: "allowlist" } }),
    ).rejects.toMatchObject({ code: "device.ceiling_on_machine" });
  });
});

/** An admitted exec on the open public network (what an owner allowlist narrowing revokes). */
function openIntent(
  f: { orgId: string; accountId: string; deviceId: string; conversationId: string },
  operationId: string,
) {
  return {
    operation_id: operationId,
    org_id: f.orgId,
    account_id: f.accountId,
    device_id: f.deviceId,
    root_conversation_id: f.conversationId,
    ordinal: 0,
    method: "exec" as const,
    input_hash: "i",
    admission_hash: "a",
    granted_hosts: "[]",
    input: "{}",
    scope: JSON.stringify({
      operationId,
      admitBeforeMs: Date.now() + 30000,
      deviceId: f.deviceId,
      rootConversationId: f.conversationId,
      profileRevision: 0,
      ceilingRevision: "c",
      profile: "full-access",
      actor: { accountId: f.accountId, conversationId: f.conversationId },
      tag: operationId,
      filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
      network: { kind: "open-public" },
    }),
    epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
    provider: "@local",
    provider_version: "0.1.0",
    instance_generation: "1",
    execution_id: randomUUID(),
    deadline: new Date(Date.now() + 60000),
    retain_until: new Date(Date.now() + 60000),
    state: "admitted" as const,
  };
}
