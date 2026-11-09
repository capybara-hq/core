import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
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
}, 180_000);

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
});
