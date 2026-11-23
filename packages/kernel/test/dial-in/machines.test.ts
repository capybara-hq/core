import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
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
let machines: DialInMachines;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
  machines = k.app.get(DialInMachines);
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

/**
 * A dial-in device of `accountId` with a signed-in machine; returns the ids and the credential.
 * Its provider is not loaded here: the machine rows and credentials never ask it.
 */
async function connected(accountId: string, org = orgId) {
  return txHost.run(async () => {
    const deviceId = randomUUID();
    await db
      .insertInto("devices")
      .values({
        id: deviceId,
        org_id: org,
        owner_kind: "personal",
        owner_account_id: accountId,
        name: `Box ${deviceId.slice(0, 6)}`,
        provider: "fake-dial-in",
      })
      .execute();
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

describe("DialInMachines", () => {
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

  it("revokeActive ends the credential; a second call is a no-op", async () => {
    const a = await member();
    const m = await connected(a);
    expect(await machines.revokeActive(m.deviceId, "revoked")).toBe(m.machineId);
    expect(await machines.authenticate(m.credential)).toBeNull();
    expect(await machines.activeFor(m.deviceId)).toBeNull();
    expect(await machines.revokeActive(m.deviceId, "revoked")).toBeNull();
  });

  it("recordConnect stores what the program reported; touch writes at most every 60 s", async () => {
    const a = await member();
    const m = await connected(a);
    await machines.recordConnect(m.machineId, {
      version: "0.2.0",
      os: "linux",
      arch: "arm64",
      bootId: "boot-1",
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
      boot_id: "boot-1",
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
