import { randomUUID } from "node:crypto";
import type {
  DeviceLocalPolicySummary,
  DeviceOwnerCeiling,
  LegacyDeviceHello,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { stagedHello } from "./fake-machine.js";

/**
 * Machine rows and credentials (environments spec §13.2): one active machine per device
 * device, a credential accepted only while the machine, its device, the org and the
 * person's membership all stand.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function member(org = orgId): Promise<string> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(org, id, "member", ownerId);
  return id;
}

/** A local device of `accountId` with a machine; returns the ids and the credential. */
async function connected(accountId: string, org = orgId) {
  return txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(
      org,
      accountId,
      `Box ${randomUUID().slice(0, 6)}`,
    );
    const issued = await machines.issue({
      orgId: org,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
}

describe("MachinesService", () => {
  it("issue returns a cap_dev_ credential that authenticates", async () => {
    const a = await member();
    const m = await connected(a);
    expect(m.credential).toMatch(/^cap_dev_[A-Za-z0-9_-]{43}$/);
    expect(await machines.authenticate(m.credential)).toEqual({
      machineId: m.machineId,
      orgId,
      deviceId: m.deviceId,
      accountId: a,
    });
    expect(await machines.authenticate("cap_pat_whatever")).toBeNull();
    expect(await machines.authenticate(`${m.credential}x`)).toBeNull();
    expect(await machines.authenticate("")).toBeNull();
  });

  it("issuing again revokes the device's active machine", async () => {
    const a = await member();
    const m = await connected(a);
    const again = await txHost.run(() =>
      machines.issue({
        orgId,
        deviceId: m.deviceId,
        accountId: a,
        name: "box-2",
        os: "darwin",
        arch: "arm64",
        programVersion: "0.1.1",
      }),
    );
    expect(await machines.authenticate(m.credential)).toBeNull();
    expect((await machines.authenticate(again.credential))?.machineId).toBe(again.machineId);
    expect((await machines.activeFor(m.deviceId))?.id).toBe(again.machineId);
  });

  it("stops authenticating when the device is deleted", async () => {
    const a = await member();
    const m = await connected(a);
    await db
      .updateTable("devices")
      .set({ deleted_at: new Date() })
      .where("id", "=", m.deviceId)
      .execute();
    expect(await machines.authenticate(m.credential)).toBeNull();
  });

  it("stops authenticating when the person leaves the org or is disabled", async () => {
    const a = await member();
    const m = await connected(a);
    await db.deleteFrom("memberships").where("account_id", "=", a).execute();
    expect(await machines.authenticate(m.credential)).toBeNull();

    const b = await member();
    const n = await connected(b);
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", b).execute();
    expect(await machines.authenticate(n.credential)).toBeNull();
  });

  it("stops authenticating when the org is deleted", async () => {
    const res = await (await session(k, "owner"))({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { name: "Doomed" },
    });
    const org = (res.json() as { org: { id: string } }).org.id;
    const a = await member(org);
    const m = await connected(a, org);
    expect(await machines.authenticate(m.credential)).not.toBeNull();
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", org).execute();
    expect(await machines.authenticate(m.credential)).toBeNull();
  });

  it("revoke ends the credential; another person's device is not_found", async () => {
    const a = await member();
    const m = await connected(a);
    const b = await member();
    await expect(machines.revoke(orgId, b, m.deviceId)).rejects.toMatchObject({
      code: "device.not_found",
    });
    await machines.revoke(orgId, a, m.deviceId);
    expect(await machines.authenticate(m.credential)).toBeNull();
    expect(await machines.activeFor(m.deviceId)).toBeNull();
    // idempotent
    await machines.revoke(orgId, a, m.deviceId);
  });

  it("recordHello keeps the known features and a valid policy summary; a later hello replaces them", async () => {
    const a = await member();
    const m = await connected(a);
    const hello: LegacyDeviceHello = {
      type: "hello",
      protocol: 2,
      programVersion: "0.3.0",
      os: "linux",
      arch: "x64",
      mode: "os",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
    };
    const policy = { allowedDomains: ["pypi.org"] };
    await machines.recordHello(m.machineId, {
      ...hello,
      features: [
        "policyOpId",
        "policyOp",
        "teleport",
        "networkReport",
        "mode",
      ] as unknown as NonNullable<LegacyDeviceHello["features"]>,
      policy,
    });
    expect(await machines.activeFor(m.deviceId)).toMatchObject({
      // "mode" is not a protocol 4 feature: dropped like an unknown name
      features: ["networkReport", "policyOp", "policyOpId"],
      localPolicy: policy,
    });
    expect((await devices.get(orgId, a, m.deviceId)).network).toEqual({
      features: ["networkReport", "policyOp", "policyOpId"],
      policy,
    });

    // a malformed summary is none
    await machines.recordHello(m.machineId, {
      ...hello,
      features: ["policyOp"],
      policy: { ...policy, allowedDomains: "x" } as unknown as NonNullable<
        LegacyDeviceHello["policy"]
      >,
    });
    expect(await machines.activeFor(m.deviceId)).toMatchObject({
      features: ["policyOp"],
      localPolicy: null,
    });

    // an older program reports neither: the kernel stops sending what it cannot do
    await machines.recordHello(m.machineId, hello);
    expect(await machines.activeFor(m.deviceId)).toMatchObject({ features: [], localPolicy: null });
    expect((await devices.get(orgId, a, m.deviceId)).network).toEqual({
      features: [],
      policy: null,
    });
  });

  // protocol 4: a summary carries no mode, so no hello audits `device.mode_changed`; the owner's
  // Full switch is the owner report's change, audited `device.owner_ceiling_changed`
  it("recordHelloV3 audits device.owner_ceiling_changed once per owner report change", async () => {
    const a = await member();
    const m = await connected(a);
    const report = (sequence: number, outsideSandbox: boolean): DeviceOwnerCeiling => ({
      ...stagedHello().ownerCeiling,
      sequence,
      revision: `r${sequence}`,
      outsideSandbox,
      restrictedProjectReach: "os-user",
    });
    const hello = (ownerCeiling: DeviceOwnerCeiling) => ({ ...stagedHello(), ownerCeiling });
    const reported = () =>
      db
        .selectFrom("audit_events")
        .select(["actor_account_id", "org_id", "detail"])
        .where("target", "=", m.deviceId)
        .where("action", "=", "device.owner_ceiling_changed")
        .orderBy("at")
        .orderBy("id")
        .execute();
    // a first report is no change, nor is the same report again
    await machines.recordHelloV3(m.machineId, hello(report(1, false)));
    await machines.recordHelloV3(m.machineId, hello(report(1, false)));
    expect(await reported()).toEqual([]);
    // the owner allowed running outside the sandbox: audited once, however many hellos say so
    await machines.recordHelloV3(m.machineId, hello(report(2, true)));
    await machines.recordHelloV3(m.machineId, hello(report(2, true)));
    expect(await reported()).toEqual([
      {
        actor_account_id: a,
        org_id: orgId,
        detail: {
          from: { outsideSandbox: false, restrictedProjectReach: "os-user" },
          to: { outsideSandbox: true, restrictedProjectReach: "os-user" },
          sequence: 2,
          by: a,
          via: "device",
          machineId: m.machineId,
        },
      },
    ]);
    // the device page lists it, made on the device
    const recent = (await devices.get(orgId, a, m.deviceId)).sandbox.recent;
    expect(recent.map((r) => [r.kind, r.ceiling, r.via])).toEqual([
      [
        "ceiling",
        {
          from: { outsideSandbox: false, restrictedProjectReach: "os-user" },
          to: { outsideSandbox: true, restrictedProjectReach: "os-user" },
        },
        "device",
      ],
    ]);
  });

  it("recordPolicy lists the owner's change on the machine once, across replicas (auto mode spec §4.2)", async () => {
    const a = await member();
    const m = await connected(a);
    const base: DeviceLocalPolicySummary = { allowedDomains: ["pypi.org"] };
    const report = (sequence: number, outsideSandbox: boolean): DeviceOwnerCeiling => ({
      ...stagedHello().ownerCeiling,
      sequence,
      revision: `r${sequence}`,
      outsideSandbox,
      allowedDomains: ["pypi.org"],
    });
    const changes = (action: string) =>
      db
        .selectFrom("audit_events")
        .select(["actor_account_id", "detail"])
        .where("target", "=", m.deviceId)
        .where("action", "=", action)
        .orderBy("at")
        .orderBy("id")
        .execute();
    // the first summary and report a machine reports are no change
    await machines.recordPolicyV3(m.machineId, {
      type: "policy",
      policy: base,
      ownerCeiling: report(1, true),
    });
    expect(await changes("device.policy_changed")).toEqual([]);
    expect(await changes("device.owner_ceiling_changed")).toEqual([]);
    // `capybara-device ceiling set --outside-sandbox deny`, reported to both replicas at once, and
    // again (protocol 4: the owner report's change, no summary mode)
    const k2 = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
    try {
      const other = k2.app.get(MachinesService);
      const next = { type: "policy", policy: base, ownerCeiling: report(2, false) };
      await Promise.all([
        machines.recordPolicyV3(m.machineId, next),
        other.recordPolicyV3(m.machineId, next),
        machines.recordPolicyV3(m.machineId, next),
        other.recordPolicyV3(m.machineId, next),
      ]);
    } finally {
      await k2.close();
    }
    // `capybara-device policy add allowedDomains files.example.com`
    const last = { allowedDomains: ["pypi.org", "files.example.com"] };
    await machines.recordPolicy(m.machineId, base);
    await machines.recordPolicy(m.machineId, last);
    await machines.recordPolicy(m.machineId, last);
    const common = {
      by: a,
      via: "device",
      machineId: m.machineId,
    };
    expect(await changes("device.policy_changed")).toEqual([
      { actor_account_id: a, detail: { add: ["files.example.com"], remove: [], ...common } },
    ]);
    expect(await changes("device.owner_ceiling_changed")).toEqual([
      {
        actor_account_id: a,
        detail: {
          from: { outsideSandbox: true, restrictedProjectReach: "workspace" },
          to: { outsideSandbox: false, restrictedProjectReach: "workspace" },
          sequence: 2,
          by: a,
          via: "device",
          machineId: m.machineId,
        },
      },
    ]);
    const recent = (await devices.get(orgId, a, m.deviceId)).sandbox.recent;
    expect(recent.map((r) => [r.kind, r.add, r.via])).toEqual([
      ["policy", ["files.example.com"], "device"],
      ["ceiling", [], "device"],
    ]);
  });

  it("recordHello stores what the program reported; touch writes at most every 60 s", async () => {
    const a = await member();
    const m = await connected(a);
    await machines.recordHello(m.machineId, {
      type: "hello",
      protocol: 2,
      programVersion: "0.2.0",
      os: "linux",
      arch: "arm64",
      mode: "docker",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
    });
    const row = await db
      .selectFrom("device_machines")
      .selectAll()
      .where("id", "=", m.machineId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      program_version: "0.2.0",
      os: "linux",
      arch: "arm64",
      mode: "docker",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      session_isolation: false,
    });
    expect(row.last_seen_at).not.toBeNull();

    const seen = row.last_seen_at as Date;
    await machines.touch(m.machineId);
    const same = await db
      .selectFrom("device_machines")
      .select("last_seen_at")
      .where("id", "=", m.machineId)
      .executeTakeFirstOrThrow();
    expect(same.last_seen_at?.getTime()).toBe(seen.getTime());

    await db
      .updateTable("device_machines")
      .set({ last_seen_at: sql<Date>`now() - interval '2 minutes'` })
      .where("id", "=", m.machineId)
      .execute();
    await machines.touch(m.machineId);
    const later = await db
      .selectFrom("device_machines")
      .select("last_seen_at")
      .where("id", "=", m.machineId)
      .executeTakeFirstOrThrow();
    expect(later.last_seen_at?.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("derives a machine's mode from its owner report only, fail closed without one", async () => {
    const a = await member();
    const m = await connected(a);
    const hello: LegacyDeviceHello = {
      type: "hello",
      protocol: 2,
      programVersion: "0.2.0",
      os: "linux",
      arch: "x64",
      mode: "os",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
      features: [],
    };
    // protocol 4 has no legacy owner state: a hello without a report is sandbox, whatever summary
    // an older program would have sent
    await machines.recordHello(m.machineId, hello);
    expect((await machines.activeFor(m.deviceId))?.localPolicy).toBeNull();
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("sandbox");
    // an authenticated report allowing outside the sandbox is auto
    await machines.recordHelloV3(m.machineId, {
      ...stagedHello(),
      ownerCeiling: { ...stagedHello().ownerCeiling, sequence: 1, outsideSandbox: true },
    });
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("auto");
    await machines.recordHelloV3(m.machineId, {
      ...stagedHello(),
      ownerCeiling: {
        ...stagedHello().ownerCeiling,
        sequence: 2,
        revision: "r2",
        outsideSandbox: false,
      },
    });
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("sandbox");
  });
});

it.each(["hello", "policy", "settle"] as const)(
  "%s takes device authority before the machine row while credential revocation runs on another connection",
  async (kind) => {
    const { vi } = await import("vitest");
    const { PermissionCeilingWrites } = await import(
      "../../src/sandbox/permission-ceiling-writes.js"
    );
    const { KernelDb } = await import("../../src/infra/database/kernel-db.js");
    const { DevicePolicyService } = await import(
      "../../src/local-devices/device-policy.service.js"
    );
    const m = await connected(await member());
    const policy = { allowedDomains: ["example.com"] };
    const opId = randomUUID();
    await db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: JSON.stringify([
          {
            id: opId,
            add: [],
            remove: ["old.example.com"],
            source: { accountId: ownerId, via: "web", approvalId: null },
            status: "sent",
            sentAt: Date.now(),
            resolveAt: Date.now() + 60000,
            until: Date.now() + 3600000,
          },
        ]),
      })
      .where("id", "=", m.machineId)
      .execute();
    let signalReady!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        signalReady = r;
      }),
      allowed = new Promise<void>((r) => {
        release = r;
      });
    const ceilings = k.app.get(PermissionCeilingWrites),
      lock = ceilings.lock.bind(ceilings),
      pids: number[] = [];
    let n = 0;
    const spy = vi.spyOn(ceilings, "lock").mockImplementation(async (subject, level) => {
      pids.push(
        (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(k.app.get(KernelDb).db))
          .rows[0]?.pid ?? 0,
      );
      if (++n === 1) {
        signalReady();
        await allowed;
        return lock(subject, level);
      }
      await lock(subject, level);
      release();
    });
    const write =
      kind === "hello"
        ? machines.recordHello(m.machineId, {
            type: "hello",
            protocol: 2,
            programVersion: "test",
            os: "linux",
            arch: "x64",
            mode: "os",
            roots: { workspace: "/w", skills: "/s", tmp: "/t" },
            sessionIsolation: false,
            policy,
          })
        : kind === "policy"
          ? machines.recordPolicy(m.machineId, policy)
          : txHost.run(() =>
              k.app
                .get(DevicePolicyService)
                .settleIn({ machineId: m.machineId, opId }, { outcome: "applied", policy }),
            );
    const writeResult = write.then(
      () => null,
      (e) => e,
    );
    try {
      await ready;
      const revoke = machines.revokeMachine(m.machineId);
      const results = await Promise.all([writeResult, revoke]);
      expect(results[0]).toBeNull();
      expect(new Set(pids).size).toBe(2);
      expect(
        (
          await db
            .selectFrom("device_machines")
            .select("revoked_at")
            .where("id", "=", m.machineId)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).not.toBeNull();
    } finally {
      release();
      spy.mockRestore();
    }
  },
);
