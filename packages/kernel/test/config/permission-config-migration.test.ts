import { createHash, randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService, readOrgSettings } from "../../src/orgs/settings.service.js";
import { readDeploymentDevicePolicy } from "../../src/sandbox/modes.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import {
  PermissionConfigPublication,
  permissionConfigFingerprint,
} from "../../src/sandbox/permission-config-publication.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * B1: the one-time v1 -> v2 conversion of the 6c publication. The old canonical algorithm and
 * fingerprints are written out here on purpose: the conversion must accept exactly what released
 * replicas published, independent of the current implementation.
 */
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let db: KernelDb;
const warnings: string[] = [];
const log = createLogger("error", { write: () => {} });
const config = (fullAccess?: "allowed" | "off", allowHosts = ["a.example"]) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    roles: ["api"],
    http: { port: 0 },
    marketplaces: { official: { enabled: false } },
    devices: fullAccess === undefined ? {} : { fullAccess },
    sandbox: { limits: { egress: "allowlist", allowHosts } },
  });
const publisher = (cfg = config()) => {
  const service = new KernelConfigService({ config: cfg, env: {} }, log);
  vi.spyOn(service, "fieldSource");
  return new PermissionConfigPublication(
    db,
    k.app.get(TransactionHost),
    service,
    k.app.get(PermissionCeilingWrites),
    { warn: (msg: string) => warnings.push(msg) },
  );
};
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type V1 = {
  autoMode: { kind: "deployment-setting" } | { kind: "configured"; value: "allowed" | "off" };
  egress: "none" | "allowlist";
  orgHosts: "extend" | "within";
  allowHosts: string[];
};
const v1 = (autoMode: V1["autoMode"] = { kind: "deployment-setting" }): V1 => ({
  autoMode,
  egress: "allowlist",
  orgHosts: "extend",
  allowHosts: ["a.example"],
});
const v2Of = (p: V1) => ({
  version: 2,
  fullAccess: p.autoMode,
  egress: p.egress,
  orgHosts: p.orgHosts,
  allowHosts: p.allowHosts,
});
const publishV1 = (p: V1, fingerprint = sha(p)) =>
  db
    .insertInto("permission_config_publication")
    .values({ id: "platform", fingerprint, projection: JSON.stringify(p) })
    .execute();
const row = () =>
  db
    .selectFrom("permission_config_publication")
    .select(["fingerprint", "projection"])
    .where("id", "=", "platform")
    .executeTakeFirstOrThrow();
const setting = async (key: string) =>
  (
    await db
      .selectFrom("deployment_settings")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst()
  )?.value;
const store = (key: string, value: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key, value: JSON.stringify(value) })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) }))
    .execute();
const authority = async () => ({
  epochs: await db.selectFrom("permission_authority_epochs").selectAll().execute(),
  outbox: await db.selectFrom("outbox").selectAll().execute(),
});
async function org(settings: Record<string, unknown>) {
  const accountId = randomUUID(),
    id = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "B1", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({
      id,
      slug: id,
      name: "B1",
      created_by: accountId,
      settings: JSON.stringify(settings),
    })
    .execute();
  await db
    .insertInto("memberships")
    .values({ org_id: id, account_id: accountId, role: "owner" })
    .execute();
  return {
    id,
    accountId,
    settings: async () =>
      (
        await db
          .selectFrom("orgs")
          .select("settings")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).settings,
  };
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(config(), { env: {}, logger: log });
  db = k.app.get(KernelDb);
  vi.spyOn(k.app.get(OutboxDispatcher), "dispatchOwn").mockResolvedValue();
});
beforeEach(async () => {
  warnings.length = 0;
  await db.deleteFrom("permission_config_publication").execute();
  await db
    .deleteFrom("deployment_settings")
    .where("key", "in", ["devicesAutoMode", "devicesFullAccess"])
    .execute();
  await db.deleteFrom("orgs").execute();
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("the v2 projection hashes the exact canonical JSON with fixed property order", () => {
  expect(permissionConfigFingerprint(config())).toBe(sha(v2Of(v1())));
  expect(permissionConfigFingerprint(config("off", ["b.example", "a.example", "a.example"]))).toBe(
    sha({
      ...v2Of(v1({ kind: "configured", value: "off" })),
      allowHosts: ["a.example", "b.example"],
    }),
  );
});

it("a format-only conversion publishes v2 under CAS and converts stored keys, nothing else", async () => {
  await publishV1(v1());
  await store("devicesAutoMode", { mode: "off" });
  const allowed = await org({ autoMode: "allowed", locale: "zh" });
  const follows = await org({ locale: "en" });
  const corrupt = await org({ autoMode: "everything" });
  const before = await authority();
  expect(await publisher().initialize()).toEqual({
    outcome: "migrated",
    activeHash: sha(v2Of(v1())),
  });
  expect(await row()).toEqual({ fingerprint: sha(v2Of(v1())), projection: v2Of(v1()) });
  expect(await setting("devicesAutoMode")).toBeUndefined();
  expect(await setting("devicesFullAccess")).toEqual({ permission: "off" });
  expect(await allowed.settings()).toEqual({ fullAccess: "allowed", locale: "zh" });
  expect(await follows.settings()).toEqual({ locale: "en" });
  expect(await corrupt.settings()).toEqual({ fullAccess: "off" });
  expect(warnings.some((w) => /autoMode.*off/.test(w))).toBe(true);
  // no fabricated widening, no blanket Full reset, no cancelled work
  expect(await authority()).toEqual(before);
  expect((await publisher().initialize()).outcome).toBe("matching");
});

it("an empty or invalid stored platform choice converts to follow or explicit off", async () => {
  await publishV1(v1());
  await store("devicesAutoMode", {});
  await publisher().initialize();
  expect(await setting("devicesFullAccess")).toEqual({});
  await db.deleteFrom("permission_config_publication").execute();
  await db.deleteFrom("deployment_settings").where("key", "=", "devicesFullAccess").execute();
  await publishV1(v1());
  await store("devicesAutoMode", { mode: "maybe" });
  await publisher().initialize();
  expect(await setting("devicesFullAccess")).toEqual({ permission: "off" });
});

it("a first v2 initialization converts the stored keys too", async () => {
  await store("devicesAutoMode", { mode: "allowed" });
  const o = await org({ autoMode: "off" });
  expect((await publisher().initialize()).outcome).toBe("initialized");
  expect(await setting("devicesFullAccess")).toEqual({ permission: "allowed" });
  expect(await o.settings()).toEqual({ fullAccess: "off" });
});

it("a semantic difference stays a mismatch until activated against the exact old hash", async () => {
  const old = v1({ kind: "configured", value: "allowed" });
  await publishV1(old);
  await store("devicesAutoMode", { mode: "allowed" });
  const b = publisher(config("off"));
  const candidateHash = permissionConfigFingerprint(config("off"));
  expect(await b.initialize()).toEqual({
    outcome: "mismatch",
    activeHash: sha(old),
    candidateHash,
  });
  expect(await row()).toEqual({ fingerprint: sha(old), projection: old });
  expect(await setting("devicesAutoMode")).toEqual({ mode: "allowed" });
  await expect(
    b.initialize({ activation: { expectedActiveHash: "0".repeat(64) } }),
  ).rejects.toThrow(/active=/);
  const platform = async () =>
    db
      .selectFrom("permission_authority_epochs")
      .selectAll()
      .where("kind", "=", "platform")
      .executeTakeFirst();
  const epoch = await platform();
  expect((await b.initialize({ activation: { expectedActiveHash: sha(old) } })).outcome).toBe(
    "activated",
  );
  expect((await row()).fingerprint).toBe(candidateHash);
  expect(await setting("devicesFullAccess")).toEqual({ permission: "allowed" });
  // Full turned off: the semantic change goes through the ceiling writer (epoch + Full revision)
  const after = await platform();
  expect(after?.revision).toBe((epoch?.revision ?? 0) + 1);
  expect(after?.full_revision).toBe((epoch?.full_revision ?? 0) + 1);
  expect((await b.initialize({ activation: { expectedActiveHash: sha(old) } })).outcome).toBe(
    "already-active",
  );
});

it("conflicting old and new stored values stop the conversion atomically", async () => {
  await publishV1(v1());
  await store("devicesAutoMode", { mode: "allowed" });
  await store("devicesFullAccess", { permission: "off" });
  await expect(publisher().initialize()).rejects.toThrow(/devicesAutoMode.*devicesFullAccess/s);
  expect(await row()).toEqual({ fingerprint: sha(v1()), projection: v1() });
  expect(await setting("devicesAutoMode")).toEqual({ mode: "allowed" });

  await store("devicesFullAccess", { permission: "allowed" });
  const o = await org({ autoMode: "off", fullAccess: "allowed" });
  await expect(publisher().initialize()).rejects.toThrow(/autoMode.*fullAccess/s);
  expect(await row()).toEqual({ fingerprint: sha(v1()), projection: v1() });
  expect(await setting("devicesAutoMode")).toEqual({ mode: "allowed" });
  expect(await o.settings()).toEqual({ autoMode: "off", fullAccess: "allowed" });
});

it("a corrupt or unknown predecessor aborts; it is never labelled current", async () => {
  await publishV1(v1(), "f".repeat(64));
  await expect(publisher().initialize()).rejects.toThrow(/fingerprint/);
  expect((await row()).fingerprint).toBe("f".repeat(64));
  await db.deleteFrom("permission_config_publication").execute();
  await db
    .insertInto("permission_config_publication")
    .values({ id: "platform", fingerprint: sha({ version: 3 }), projection: '{"version":3}' })
    .execute();
  await expect(publisher().initialize()).rejects.toThrow();
  await expect(
    publisher().initialize({ activation: { expectedActiveHash: sha({ version: 3 }) } }),
  ).rejects.toThrow();
  expect((await row()).fingerprint).toBe(sha({ version: 3 }));
});

it("old replicas fail the barrier after conversion; their CAS predecessor is stale", async () => {
  await publishV1(v1());
  const p = publisher();
  await p.initialize();
  await expect(p.assertCurrent()).resolves.toBeUndefined();
  const active = await row();
  // an old replica compares its v1 hash, and its strict v1 parser refuses the versioned row
  expect(active.fingerprint).not.toBe(sha(v1()));
  expect(Object.keys(active.projection as object)).toContain("version");
  expect(Object.keys(active.projection as object)).not.toContain("autoMode");
  // a hot reload from a replica still on the old local projection loses the CAS
  const stale = publisher(config("off"));
  await expect(
    stale.publish(
      { ...config(), devices: { ...config().devices, fullAccess: "allowed" } },
      config("off"),
    ),
  ).rejects.toThrow(/another replica/);
  expect((await row()).fingerprint).toBe(active.fingerprint);
});

describe("the window before conversion and stale-replica writes (fail closed until 8.6)", () => {
  const changed = () => config(undefined, ["b.example"]);
  async function admin() {
    const id = randomUUID();
    await db
      .insertInto("accounts")
      .values({ id, display_name: "B1 admin", email: null, is_super_admin: true })
      .execute();
    return id;
  }

  it("a mismatch window reads the legacy off, an org write keeps it, activation converts to off", async () => {
    await publishV1(v1());
    await store("devicesAutoMode", { mode: "off" });
    const a = await org({ autoMode: "off" });
    const p = publisher(changed());
    expect((await p.initialize()).outcome).toBe("mismatch");
    // the stored legacy keys are not converted, yet every new reader sees their off
    expect((await k.app.get(SettingsService).view()).devicesFullAccess).toEqual({
      permission: "off",
      source: "db",
    });
    expect((await readOrgSettings(db.db, a.id)).fullAccess).toBe("off");
    expect((await k.app.get(OrgSettingsService).get(a.id)).fullAccess).toBe("off");
    expect(
      (await readDeploymentDevicePolicy(db.db, k.app.get(KernelConfigService))).fullAccess,
    ).toBe("off");
    // an unrelated org write never drops the legacy key: it is carried, never erased
    await k.app.get(OrgSettingsService).update(a.id, { locale: "zh" }, a.accountId);
    expect(await a.settings()).toMatchObject({ autoMode: "off", fullAccess: "off", locale: "zh" });
    expect((await readOrgSettings(db.db, a.id)).fullAccess).toBe("off");
    await p.initialize({ activation: { expectedActiveHash: sha(v1()) } });
    expect(await a.settings()).toMatchObject({ fullAccess: "off", locale: "zh" });
    expect(await a.settings()).not.toHaveProperty("autoMode");
    expect(await setting("devicesFullAccess")).toEqual({ permission: "off" });
  });

  it("a window write of the new key carries the old one for old replicas", async () => {
    await publishV1(v1());
    await store("devicesAutoMode", { mode: "off" });
    const a = await org({ autoMode: "off" });
    await publisher(changed()).initialize();
    await k.app.get(OrgSettingsService).update(a.id, { fullAccess: null }, a.accountId);
    expect(await a.settings()).not.toHaveProperty("fullAccess");
    expect(await a.settings()).not.toHaveProperty("autoMode");
    const id = await admin();
    await k.app.get(SettingsService).update({ devicesFullAccess: { permission: "allowed" } }, id);
    expect(await setting("devicesAutoMode")).toEqual({ mode: "allowed" });
    expect(await setting("devicesFullAccess")).toEqual({ permission: "allowed" });
  });

  it("a divergent stored pair resolves to the narrower value; no write is refused", async () => {
    await publishV1(v1());
    const a = await org({ autoMode: "off", fullAccess: "allowed" });
    await publisher(changed()).initialize();
    expect((await readOrgSettings(db.db, a.id)).fullAccess).toBe("off");
    await k.app.get(OrgSettingsService).update(a.id, { locale: "zh" }, a.accountId);
    expect(await a.settings()).toMatchObject({ autoMode: "off", fullAccess: "off", locale: "zh" });
  });

  it("an agreeing stored pair never blocks a write that leaves fullAccess alone", async () => {
    await publishV1(v1());
    const a = await org({ autoMode: "allowed", fullAccess: "allowed" });
    await publisher(changed()).initialize();
    const settings = k.app.get(OrgSettingsService);
    await settings.update(a.id, { locale: "zh" }, a.accountId);
    await settings.update(a.id, { cloudNetwork: { mode: "allowlist" } }, a.accountId);
    expect(await a.settings()).toMatchObject({
      autoMode: "allowed",
      fullAccess: "allowed",
      locale: "zh",
      cloudNetwork: { mode: "allowlist" },
    });
  });

  it("stale-replica legacy writes after conversion still narrow", async () => {
    await publishV1(v1());
    const a = await org({ autoMode: "allowed" });
    expect((await publisher().initialize()).outcome).toBe("migrated");
    // what an old replica writes: its own key, keeping the new one it does not know
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ fullAccess: "allowed", autoMode: "off" }) })
      .where("id", "=", a.id)
      .execute();
    await store("devicesAutoMode", { mode: "off" });
    expect((await readOrgSettings(db.db, a.id)).fullAccess).toBe("off");
    expect((await k.app.get(SettingsService).view()).devicesFullAccess.permission).toBe("off");
    // an invalid old value narrows too
    await store("devicesAutoMode", { mode: "maybe" });
    await store("devicesFullAccess", { permission: "allowed" });
    expect((await k.app.get(SettingsService).view()).devicesFullAccess.permission).toBe("off");
  });
});
