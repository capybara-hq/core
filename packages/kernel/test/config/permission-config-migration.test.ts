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
 * The one-time conversion of the published permission projection to version 3 (approval-only
 * profiles design, "Migration"), from version 2 (B1) and version 1 (6c). The old canonical
 * algorithms and fingerprints are written out here on purpose: the conversion must accept exactly
 * what released replicas published, independent of the current implementation.
 */
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let db: KernelDb;
const warnings: string[] = [];
const log = createLogger("error", { write: () => {} });
type Devices = {
  outsideSandbox?: "allowed" | "off";
  network?: { default?: "open" | "allowlist"; ceiling?: "open" | "allowlist" };
};
const config = (
  devices: Devices = {},
  allowHosts = ["a.example"],
  orgHosts: "extend" | "within" = "extend",
) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    roles: ["api"],
    http: { port: 0 },
    marketplaces: { official: { enabled: false } },
    devices,
    sandbox: { limits: { egress: "allowlist", allowHosts, orgHosts } },
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
type Source<T> = { kind: "deployment-setting" } | { kind: "configured"; value: T };
const SETTING = { kind: "deployment-setting" } as const;
type V1 = {
  autoMode: Source<"allowed" | "off">;
  egress: "none" | "allowlist";
  orgHosts: "extend" | "within";
  allowHosts: string[];
};
type V2 = Omit<V1, "autoMode"> & { version: 2; fullAccess: Source<"allowed" | "off"> };
const v1 = (autoMode: V1["autoMode"] = SETTING): V1 => ({
  autoMode,
  egress: "allowlist",
  orgHosts: "extend",
  allowHosts: ["a.example"],
});
const v2 = (fullAccess: V2["fullAccess"] = SETTING): V2 => ({
  version: 2,
  fullAccess,
  egress: "allowlist",
  orgHosts: "extend",
  allowHosts: ["a.example"],
});
const v3 = (
  outsideSandbox: Source<"allowed" | "off"> = SETTING,
  network: { default?: Source<"open" | "allowlist">; ceiling?: Source<"open" | "allowlist"> } = {},
) => ({
  version: 3,
  outsideSandbox,
  network: { default: network.default ?? SETTING, ceiling: network.ceiling ?? SETTING },
  egress: "allowlist",
  orgHosts: "extend",
  allowHosts: ["a.example"],
});
const publishOld = (p: V1 | V2, fingerprint = sha(p)) =>
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
    .values({ id: accountId, display_name: "R3", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({
      id,
      slug: id,
      name: "R3",
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
    .where("key", "in", [
      "devicesAutoMode",
      "devicesFullAccess",
      "devicesOutsideSandbox",
      "devicesNetwork",
    ])
    .execute();
  await db.deleteFrom("orgs").execute();
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("the v3 projection hashes the exact canonical JSON with fixed property order", () => {
  expect(permissionConfigFingerprint(config())).toBe(sha(v3()));
  expect(
    permissionConfigFingerprint(
      config({ outsideSandbox: "off", network: { ceiling: "allowlist" } }, [
        "b.example",
        "a.example",
        "a.example",
      ]),
    ),
  ).toBe(
    sha({
      ...v3(
        { kind: "configured", value: "off" },
        { ceiling: { kind: "configured", value: "allowlist" } },
      ),
      allowHosts: ["a.example", "b.example"],
    }),
  );
});

it("a change to any new key changes the fingerprint", () => {
  const base = permissionConfigFingerprint(config());
  const variants: Devices[] = [
    { outsideSandbox: "allowed" },
    { outsideSandbox: "off" },
    { network: { default: "open" } },
    { network: { default: "allowlist" } },
    { network: { ceiling: "open" } },
    { network: { ceiling: "allowlist" } },
  ];
  const hashes = variants.map((d) => permissionConfigFingerprint(config(d)));
  expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
});

it("a format-only v2 conversion publishes v3 under CAS and converts stored keys, nothing else", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", { permission: "allowed" });
  const allowed = await org({ fullAccess: "allowed", locale: "zh" });
  const off = await org({ fullAccess: "off", cloudNetwork: { extraHosts: ["pypi.org"] } });
  const follows = await org({ locale: "en", cloudNetwork: { mode: "open" } });
  const corrupt = await org({ autoMode: "everything" });
  const allowlist = await org({
    cloudNetwork: { mode: "allowlist", base: "none", excludedHosts: ["github.com"] },
  });
  const before = await authority();
  expect(await publisher().initialize()).toEqual({ outcome: "migrated", activeHash: sha(v3()) });
  expect(await row()).toEqual({ fingerprint: sha(v3()), projection: v3() });
  expect(await setting("devicesFullAccess")).toBeUndefined();
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
  expect(await setting("devicesNetwork")).toBeUndefined();
  expect(await allowed.settings()).toEqual({ outsideSandbox: "allowed", locale: "zh" });
  // an old off kept the org's devices on the allowlist: never wider
  expect(await off.settings()).toEqual({
    outsideSandbox: "off",
    deviceNetwork: { ceiling: "allowlist", extraHosts: ["pypi.org"] },
  });
  expect(await follows.settings()).toEqual({ locale: "en" });
  expect(await corrupt.settings()).toEqual({
    outsideSandbox: "off",
    deviceNetwork: { ceiling: "allowlist" },
  });
  expect(await allowlist.settings()).toEqual({
    deviceNetwork: { ceiling: "allowlist", base: "none", excludedHosts: ["github.com"] },
  });
  expect(warnings.some((w) => /autoMode.*off/.test(w))).toBe(true);
  // no fabricated widening, no blanket Full reset, no cancelled work
  expect(await authority()).toEqual(before);
  expect((await publisher().initialize()).outcome).toBe("matching");
});

it("a v1 publication converts to v3 too", async () => {
  await publishOld(v1());
  await store("devicesAutoMode", { mode: "allowed" });
  expect((await publisher().initialize()).outcome).toBe("migrated");
  expect(await setting("devicesAutoMode")).toBeUndefined();
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
});

it("a configured old off matches only a config that also limits the network", async () => {
  const old = v2({ kind: "configured", value: "off" });
  await publishOld(old);
  // what migrate-permissions writes: outsideSandbox off plus the allowlist ceiling
  const converted = config({ outsideSandbox: "off", network: { ceiling: "allowlist" } });
  expect((await publisher(converted).initialize()).outcome).toBe("migrated");
  await db.deleteFrom("permission_config_publication").execute();
  await publishOld(old);
  // a hand rename without the ceiling would widen local devices: it stays a mismatch
  expect((await publisher(config({ outsideSandbox: "off" })).initialize()).outcome).toBe(
    "mismatch",
  );
});

it("an empty, off or invalid stored platform choice converts to follow, or off with the allowlist", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", {});
  await publisher().initialize();
  expect(await setting("devicesOutsideSandbox")).toEqual({});
  expect(await setting("devicesNetwork")).toBeUndefined();
  for (const value of [{ permission: "off" }, { permission: "maybe" }]) {
    await db.deleteFrom("permission_config_publication").execute();
    await db
      .deleteFrom("deployment_settings")
      .where("key", "in", ["devicesOutsideSandbox", "devicesNetwork"])
      .execute();
    await publishOld(v2());
    await store("devicesFullAccess", value);
    await publisher().initialize();
    expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "off" });
    expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
  }
});

it("a first v3 initialization converts the stored keys too", async () => {
  await store("devicesFullAccess", { permission: "allowed" });
  const o = await org({ fullAccess: "off" });
  expect((await publisher().initialize()).outcome).toBe("initialized");
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
  expect(await o.settings()).toEqual({
    outsideSandbox: "off",
    deviceNetwork: { ceiling: "allowlist" },
  });
});

it("a semantic difference stays a mismatch until activated against the exact old hash", async () => {
  const old = v2({ kind: "configured", value: "allowed" });
  await publishOld(old);
  await store("devicesFullAccess", { permission: "allowed" });
  const next = config({ outsideSandbox: "off" });
  const b = publisher(next);
  const candidateHash = permissionConfigFingerprint(next);
  expect(await b.initialize()).toEqual({
    outcome: "mismatch",
    activeHash: sha(old),
    candidateHash,
  });
  expect(await row()).toEqual({ fingerprint: sha(old), projection: old });
  expect(await setting("devicesFullAccess")).toEqual({ permission: "allowed" });
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
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
  // outside turned off: the semantic change goes through the ceiling writer (its epoch); a
  // narrowing keeps Full consent (only a widening bumps the Full revision)
  const after = await platform();
  expect(after?.revision).toBe((epoch?.revision ?? 0) + 1);
  expect(after?.full_revision).toBe(epoch?.full_revision ?? 0);
  expect((await b.initialize({ activation: { expectedActiveHash: sha(old) } })).outcome).toBe(
    "already-active",
  );
});

it("divergent old and new stored values convert to what readers saw, never refused", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", { permission: "allowed" });
  await store("devicesOutsideSandbox", { permission: "off" });
  const o = await org({ fullAccess: "off", outsideSandbox: "allowed" });
  expect((await publisher().initialize()).outcome).toBe("migrated");
  expect(await setting("devicesFullAccess")).toBeUndefined();
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "off" });
  expect(await o.settings()).toEqual({
    outsideSandbox: "off",
    deviceNetwork: { ceiling: "allowlist" },
  });
});

it("the conversion stores exactly the network readers saw (M1)", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", { permission: "off" });
  await store("devicesNetwork", { ceiling: "open" });
  const view = async () => (await k.app.get(SettingsService).view()).devicesNetwork.ceiling;
  expect(await view()).toBe("allowlist");
  expect((await publisher().initialize()).outcome).toBe("migrated");
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "off" });
  expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
  expect(await view()).toBe("allowlist");
});

it("an empty converted network removes the stored row", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", { permission: "allowed" });
  await store("devicesNetwork", {});
  await publisher().initialize();
  expect(await setting("devicesNetwork")).toBeUndefined();
});

it("orgHosts within: cloud devices on the old allowlist keep it (M4)", async () => {
  const within = config({}, ["a.example"], "within");
  await publishOld({ ...v2(), orgHosts: "within" });
  const o = await org({});
  const device = async (mode: "sandbox" | null) => {
    const id = randomUUID();
    await db
      .insertInto("devices")
      .values({
        id,
        org_id: o.id,
        owner_kind: "personal",
        owner_account_id: o.accountId,
        source: "cloud",
        mode,
      })
      .execute();
    return id;
  };
  const sandboxed = await device("sandbox");
  const auto = await device(null);
  const local = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: local,
      org_id: o.id,
      owner_kind: "personal",
      owner_account_id: o.accountId,
      source: "local",
    })
    .execute();
  expect((await publisher(within).initialize()).outcome).toBe("migrated");
  const net = async (id: string) =>
    db
      .selectFrom("devices")
      .select(["network_mode", "network_hosts"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  expect(await net(sandboxed)).toEqual({ network_mode: "allowlist", network_hosts: [] });
  // auto mode ran on the open network; a local device has no cloud network
  expect(await net(auto)).toEqual({ network_mode: null, network_hosts: [] });
  expect(await net(local)).toEqual({ network_mode: null, network_hosts: [] });
  await db.deleteFrom("devices").execute();
});

it("old keys an old replica writes after conversion convert on the next publish", async () => {
  await publishOld(v2());
  const p = publisher();
  expect((await p.initialize()).outcome).toBe("migrated");
  const o = await org({ outsideSandbox: "allowed", fullAccess: "off" });
  await store("devicesFullAccess", { permission: "off" });
  await p.publish(config(), config({ network: { default: "open" } }));
  expect(await setting("devicesFullAccess")).toBeUndefined();
  expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "off" });
  expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
  expect(await o.settings()).toEqual({
    outsideSandbox: "off",
    deviceNetwork: { ceiling: "allowlist" },
  });
});

it("the conversion warns once per platform or org it narrowed, with how to reopen it", async () => {
  await publishOld(v2());
  await store("devicesFullAccess", { permission: "off" });
  const o = await org({ fullAccess: "off" });
  await publisher().initialize();
  expect(warnings.filter((w) => /platform.*allowlist.*devicesNetwork/s.test(w))).toHaveLength(1);
  expect(
    warnings.filter((w) => w.includes(o.id) && /allowlist.*deviceNetwork/s.test(w)),
  ).toHaveLength(1);
});

it("a corrupt or unknown predecessor aborts; it is never labelled current", async () => {
  await publishOld(v2(), "f".repeat(64));
  await expect(publisher().initialize()).rejects.toThrow(/fingerprint/);
  expect((await row()).fingerprint).toBe("f".repeat(64));
  await db.deleteFrom("permission_config_publication").execute();
  await db
    .insertInto("permission_config_publication")
    .values({ id: "platform", fingerprint: sha({ version: 4 }), projection: '{"version":4}' })
    .execute();
  await expect(publisher().initialize()).rejects.toThrow();
  await expect(
    publisher().initialize({ activation: { expectedActiveHash: sha({ version: 4 }) } }),
  ).rejects.toThrow();
  expect((await row()).fingerprint).toBe(sha({ version: 4 }));
});

it("old replicas fail the barrier after conversion; their CAS predecessor is stale", async () => {
  await publishOld(v2());
  const p = publisher();
  await p.initialize();
  await expect(p.assertCurrent()).resolves.toBeUndefined();
  const active = await row();
  // an old replica compares its v2 hash, and its strict v2 parser refuses the v3 row
  expect(active.fingerprint).not.toBe(sha(v2()));
  expect((active.projection as { version: number }).version).toBe(3);
  expect(Object.keys(active.projection as object)).not.toContain("fullAccess");
  // a hot reload from a replica still on the old local projection loses the CAS
  const stale = publisher(config({ outsideSandbox: "off" }));
  await expect(
    stale.publish(config({ outsideSandbox: "allowed" }), config({ outsideSandbox: "off" })),
  ).rejects.toThrow(/another replica/);
  expect((await row()).fingerprint).toBe(active.fingerprint);
});

describe("the window before conversion and stale-replica writes (fail closed)", () => {
  const changed = () => config({}, ["b.example"]);
  async function admin() {
    const id = randomUUID();
    await db
      .insertInto("accounts")
      .values({ id, display_name: "R3 admin", email: null, is_super_admin: true })
      .execute();
    return id;
  }

  it("a mismatch window reads the legacy off, an org write keeps it, activation converts it", async () => {
    await publishOld(v2());
    await store("devicesFullAccess", { permission: "off" });
    const a = await org({ fullAccess: "off" });
    const p = publisher(changed());
    expect((await p.initialize()).outcome).toBe("mismatch");
    // the stored legacy keys are not converted, yet every new reader sees their off
    const view = await k.app.get(SettingsService).view();
    expect(view.devicesOutsideSandbox).toEqual({ permission: "off", source: "db" });
    expect(view.devicesNetwork.ceiling).toBe("allowlist");
    expect((await readOrgSettings(db.db, a.id)).outsideSandbox).toBe("off");
    expect((await k.app.get(OrgSettingsService).get(a.id)).deviceNetwork).toEqual({
      ceiling: "allowlist",
    });
    expect(
      (await readDeploymentDevicePolicy(db.db, k.app.get(KernelConfigService))).fullAccess,
    ).toBe("off");
    // an unrelated org write never drops the legacy key: it is carried, never erased
    await k.app.get(OrgSettingsService).update(a.id, { locale: "zh" }, a.accountId);
    expect(await a.settings()).toMatchObject({ fullAccess: "off", outsideSandbox: "off" });
    expect((await readOrgSettings(db.db, a.id)).outsideSandbox).toBe("off");
    await p.initialize({ activation: { expectedActiveHash: sha(v2()) } });
    expect(await a.settings()).toMatchObject({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist" },
      locale: "zh",
    });
    expect(await a.settings()).not.toHaveProperty("fullAccess");
    expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "off" });
    expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
  });

  it("a window write of the new keys carries the old ones for old replicas", async () => {
    await publishOld(v2());
    await store("devicesFullAccess", { permission: "off" });
    const a = await org({ fullAccess: "off", cloudNetwork: { extraHosts: ["pypi.org"] } });
    await publisher(changed()).initialize();
    await k.app
      .get(OrgSettingsService)
      .update(a.id, { outsideSandbox: null, deviceNetwork: null }, a.accountId);
    // cleared: the old keys go too, and the follow marker keeps the old off from narrowing again
    expect(((await a.settings()) as { deviceNetwork?: unknown }).deviceNetwork).toEqual({});
    for (const key of ["fullAccess", "outsideSandbox", "cloudNetwork"])
      expect(await a.settings()).not.toHaveProperty(key);
    expect((await readOrgSettings(db.db, a.id)).deviceNetwork).toBeUndefined();
    await k.app
      .get(OrgSettingsService)
      .update(
        a.id,
        { deviceNetwork: { ceiling: "allowlist", extraHosts: ["pypi.org"] } },
        a.accountId,
      );
    const id = await admin();
    await k.app
      .get(SettingsService)
      .update({ devicesOutsideSandbox: { permission: "allowed" } }, id);
    // old replicas read Full allowed only when the network ceiling is open too: here it is the
    // allowlist the old off implied, so they keep reading off
    expect(await setting("devicesFullAccess")).toEqual({ permission: "off" });
    expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
    // the network the old off implied is stored, so allowing outside runs never opens it
    expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
    // the new keys read as written: the old key is in step, not a narrowing
    const view = await k.app.get(SettingsService).view();
    expect(view.devicesOutsideSandbox.permission).toBe("allowed");
    expect(view.devicesNetwork.ceiling).toBe("allowlist");
    // a network write rewrites the old key in step: an open ceiling lets old replicas allow Full
    await k.app.get(SettingsService).update({ devicesNetwork: { ceiling: "open" } }, id);
    expect(await setting("devicesFullAccess")).toEqual({ permission: "allowed" });
    expect(await setting("devicesNetwork")).toEqual({ ceiling: "open" });
  });

  it("a network-only window write stores the outside key too, and the old key in step", async () => {
    await publishOld(v2());
    await store("devicesFullAccess", { permission: "allowed" });
    const a = await org({ fullAccess: "allowed" });
    await publisher(changed()).initialize();
    const id = await admin();
    await k.app.get(SettingsService).update({ devicesNetwork: { ceiling: "allowlist" } }, id);
    expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
    expect(await setting("devicesFullAccess")).toEqual({ permission: "off" });
    expect((await k.app.get(SettingsService).view()).devicesOutsideSandbox.permission).toBe(
      "allowed",
    );
    await k.app
      .get(OrgSettingsService)
      .update(a.id, { deviceNetwork: { ceiling: "allowlist" } }, a.accountId);
    expect(await a.settings()).toMatchObject({
      outsideSandbox: "allowed",
      fullAccess: "off",
      deviceNetwork: { ceiling: "allowlist" },
    });
    expect((await readOrgSettings(db.db, a.id)).outsideSandbox).toBe("allowed");
    // activation converts to exactly that
    await publisher(changed()).initialize({ activation: { expectedActiveHash: sha(v2()) } });
    expect(await setting("devicesFullAccess")).toBeUndefined();
    expect(await setting("devicesOutsideSandbox")).toEqual({ permission: "allowed" });
    expect(await setting("devicesNetwork")).toEqual({ ceiling: "allowlist" });
    expect(await a.settings()).not.toHaveProperty("fullAccess");
    expect(await a.settings()).toMatchObject({ outsideSandbox: "allowed" });
  });

  it("an org write keeps an old cloudNetwork in step", async () => {
    await publishOld(v2());
    const a = await org({ cloudNetwork: { mode: "allowlist", extraHosts: ["pypi.org"] } });
    await publisher(changed()).initialize();
    await k.app.get(OrgSettingsService).update(
      a.id,
      {
        deviceNetwork: { default: "allowlist", ceiling: "open", extraHosts: ["pypi.org", "x.org"] },
      },
      a.accountId,
    );
    expect(await a.settings()).toMatchObject({
      deviceNetwork: { default: "allowlist", ceiling: "open", extraHosts: ["pypi.org", "x.org"] },
      cloudNetwork: { mode: "allowlist", extraHosts: ["pypi.org", "x.org"] },
    });
    // in step: the new value reads as written
    expect((await readOrgSettings(db.db, a.id)).deviceNetwork?.ceiling).toBe("open");
  });

  it("stale-replica legacy writes after conversion still narrow", async () => {
    await publishOld(v2());
    const a = await org({ fullAccess: "allowed" });
    expect((await publisher().initialize()).outcome).toBe("migrated");
    // what an old replica writes: its own key, keeping the new one it does not know
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ outsideSandbox: "allowed", fullAccess: "off" }) })
      .where("id", "=", a.id)
      .execute();
    await store("devicesFullAccess", { permission: "off" });
    expect((await readOrgSettings(db.db, a.id)).outsideSandbox).toBe("off");
    expect((await readOrgSettings(db.db, a.id)).deviceNetwork?.ceiling).toBe("allowlist");
    expect((await k.app.get(SettingsService).view()).devicesOutsideSandbox.permission).toBe("off");
    // an invalid old value narrows too
    await store("devicesFullAccess", { permission: "maybe" });
    await store("devicesOutsideSandbox", { permission: "allowed" });
    expect((await k.app.get(SettingsService).view()).devicesOutsideSandbox.permission).toBe("off");
  });
});
