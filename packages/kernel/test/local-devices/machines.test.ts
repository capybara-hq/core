import { randomUUID } from "node:crypto";
import type { DeviceHello, DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";
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
    const hello: DeviceHello = {
      type: "hello",
      protocol: 1,
      programVersion: "0.3.0",
      os: "linux",
      arch: "x64",
      mode: "os",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
    };
    const policy = {
      mode: "auto" as const,
      allowedDomains: ["pypi.org"],
    };
    await machines.recordHello(m.machineId, {
      ...hello,
      features: [
        "policyOpId",
        "policyOp",
        "teleport",
        "networkReport",
        "mode",
      ] as unknown as NonNullable<DeviceHello["features"]>,
      policy,
    });
    expect(await machines.activeFor(m.deviceId)).toMatchObject({
      features: ["networkReport", "policyOp", "policyOpId", "mode"],
      localPolicy: policy,
    });
    expect((await devices.get(orgId, a, m.deviceId)).network).toEqual({
      features: ["networkReport", "policyOp", "policyOpId", "mode"],
      policy,
    });

    // a malformed summary is none
    await machines.recordHello(m.machineId, {
      ...hello,
      features: ["policyOp"],
      policy: { ...policy, allowedDomains: "x" } as unknown as NonNullable<DeviceHello["policy"]>,
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

  it("recordHello audits device.mode_changed once per change (auto mode spec §4.2)", async () => {
    const a = await member();
    const m = await connected(a);
    const hello: DeviceHello = {
      type: "hello",
      protocol: 1,
      programVersion: "0.3.0",
      os: "linux",
      arch: "x64",
      mode: "os",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
      features: ["networkReport", "policyOp", "mode"],
    };
    const policy = (mode: "auto" | "sandbox") => ({ mode, allowedDomains: [] });
    const reported = () =>
      db
        .selectFrom("audit_events")
        .select(["actor_account_id", "org_id", "detail"])
        .where("target", "=", m.deviceId)
        .where("action", "=", "device.mode_changed")
        .orderBy("at")
        .orderBy("id")
        .execute();
    // a first hello with sandbox mode is no change
    await machines.recordHello(m.machineId, { ...hello, policy: policy("sandbox") });
    await machines.recordHello(m.machineId, { ...hello, policy: policy("sandbox") });
    expect(await reported()).toEqual([]);
    // the owner switched the machine to auto mode: audited once, however many hellos say so
    await machines.recordHello(m.machineId, { ...hello, policy: policy("auto") });
    await machines.recordHello(m.machineId, { ...hello, policy: policy("auto") });
    expect(await reported()).toEqual([
      {
        actor_account_id: a,
        org_id: orgId,
        detail: {
          from: "sandbox",
          to: "auto",
          by: a,
          via: "device",
          machineId: m.machineId,
        },
      },
    ]);
    // the device page lists it, made on the device
    const recent = (await devices.get(orgId, a, m.deviceId)).mode.recent;
    expect(recent.map((r) => [r.kind, r.mode, r.via])).toEqual([
      ["mode", { from: "sandbox", to: "auto" }, "device"],
    ]);
  });

  it("recordPolicy lists the owner's change on the machine once, across replicas (auto mode spec §4.2)", async () => {
    const a = await member();
    const m = await connected(a);
    const base: DeviceLocalPolicySummary = {
      mode: "auto",
      allowedDomains: ["pypi.org"],
    };
    const changes = (action: string) =>
      db
        .selectFrom("audit_events")
        .select(["actor_account_id", "detail"])
        .where("target", "=", m.deviceId)
        .where("action", "=", action)
        .orderBy("at")
        .orderBy("id")
        .execute();
    // the first summary a machine reports is no change
    await machines.recordPolicy(m.machineId, base);
    expect(await changes("device.policy_changed")).toEqual([]);
    expect(await changes("device.mode_changed")).toEqual([]);
    // `capybara-device mode sandbox`, reported to both replicas at once, and again
    const k2 = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
    try {
      const other = k2.app.get(MachinesService);
      const next = { ...base, mode: "sandbox" as const };
      await Promise.all([
        machines.recordPolicy(m.machineId, next),
        other.recordPolicy(m.machineId, next),
        machines.recordPolicy(m.machineId, next),
        other.recordPolicy(m.machineId, next),
      ]);
    } finally {
      await k2.close();
    }
    // `capybara-device policy add allowedDomains files.example.com`
    const last = {
      ...base,
      mode: "sandbox" as const,
      allowedDomains: ["pypi.org", "files.example.com"],
    };
    await machines.recordPolicy(m.machineId, { ...last, allowedDomains: ["pypi.org"] });
    await machines.recordPolicy(m.machineId, last);
    await machines.recordPolicy(m.machineId, last);
    const common = {
      by: a,
      via: "device",
      machineId: m.machineId,
      approvalId: null,
    };
    expect(await changes("device.policy_changed")).toEqual([
      { actor_account_id: a, detail: { add: ["files.example.com"], remove: [], ...common } },
    ]);
    expect(await changes("device.mode_changed")).toEqual([
      {
        actor_account_id: a,
        detail: { from: "auto", to: "sandbox", by: a, via: "device", machineId: m.machineId },
      },
    ]);
    const recent = (await devices.get(orgId, a, m.deviceId)).mode.recent;
    expect(recent.map((r) => [r.kind, r.add, r.mode, r.via])).toEqual([
      ["policy", ["files.example.com"], null, "device"],
      ["mode", [], { from: "auto", to: "sandbox" }, "device"],
    ]);
  });

  it("recordHello stores what the program reported; touch writes at most every 60 s", async () => {
    const a = await member();
    const m = await connected(a);
    await machines.recordHello(m.machineId, {
      type: "hello",
      protocol: 1,
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

  it("derives a pre-auto-mode program's mode fail-closed (unsandboxed old summary is auto)", async () => {
    const a = await member();
    const m = await connected(a);
    const hello: DeviceHello = {
      type: "hello",
      protocol: 1,
      programVersion: "0.2.0",
      os: "linux",
      arch: "x64",
      mode: "os",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" },
      sessionIsolation: false,
      features: [],
    };
    const legacy = {
      tier: "open",
      effectiveTier: "open",
      isolation: "none",
      localhost: "on",
      unixSockets: "roots",
      allowedDomains: [],
      remoteGrants: "owner",
    };
    // the frame parser drops the old summary; MachinesService keeps its isolation
    await machines.recordHello(m.machineId, hello, legacy);
    expect((await machines.activeFor(m.deviceId))?.localPolicy).toBeNull();
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("auto");
    // a legacy summary that was sandboxed is sandbox
    await machines.recordHello(m.machineId, hello, { ...legacy, isolation: "sandbox" });
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("sandbox");
    // a program that applies modes but sends no readable summary fails closed
    await machines.recordHello(m.machineId, { ...hello, features: ["mode"] });
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("sandbox");
  });
});
