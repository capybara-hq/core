import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type ExtensionManifest,
  orgAccess,
  secret,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../../src/config/load.js";
import { extensionConfigSources } from "../../src/config/sources.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs, mergeCopy } from "../../src/extensions/effective-config.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import {
  createOrg,
  type Req,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Org copies of overridable deployment config and the effective config (layering spec A §5.3 to
 * §5.8, §6 `needsConfig`). `orglevels` is installed as a package (an install record), so the
 * deployment can disable it and upgrade it to `orglevels-v2`.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

// distinctive secret values, so "never in a response" checks mean something
const PK = "pk-Zx81platform";
const OK = "ok-Qw72org";
const OK2 = "ok2-Lm55-org-key";
const SHORT = "ok-short";
const LONG = "ok-long-Rt66-key";

interface OverrideField {
  path: string;
  level: "readonly" | "override";
  secret: boolean;
  platform: { value?: unknown; set?: boolean };
  org?: { value?: unknown; set?: boolean };
  differs?: boolean;
}
interface OverrideView {
  state: "following" | "copy";
  createdAt?: string;
  schema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  } | null;
  fields: OverrideField[];
  valid: boolean;
  issues: { path: string; message: string }[];
}

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel | undefined;
let root: Req;
let owner: Req;
let member: Req;
let orgA: string;
let orgB: string;
let orgC: string;
const secretBodies: string[] = [];

const base = (env: Record<string, string>) =>
  resolveConfig(
    {
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api", "worker"],
      extensionPermissions: { autoApprove: true },
    },
    env,
  );

async function boot(env: Record<string, string> = {}): Promise<TestKernel> {
  const kernel = await startKernel(base(env), {
    env,
    extensionConfigSources: extensionConfigSources({}, env, "file"),
  });
  root = await session(kernel, "root");
  owner = await session(kernel, "owner");
  member = await session(kernel, "mem");
  return kernel;
}

async function packOf(dir: string): Promise<Uint8Array> {
  const { stripTypeScriptTypes } = await import("node:module");
  const mod = (await import(fx(dir))) as { default: ExtensionManifest };
  return pluginTgz({
    manifest: { name: "orglevels", version: mod.default.version },
    packageName: "@test/plugin-orglevels",
    extension: {
      manifest: staticManifestOf(mod.default) as unknown as Record<string, unknown>,
      entry: stripTypeScriptTypes(await readFile(fx(dir), "utf8"), { mode: "strip" }),
    },
  });
}

/** Uploads and installs (or upgrades to) a fixture version; resolves once this replica runs it. */
async function deploy(dir: string, version: string): Promise<void> {
  const up = await root({
    method: "POST",
    url: "/api/v1/admin/extensions/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(await packOf(dir)),
  });
  expect(up.statusCode, up.body).toBe(200);
  const inst = await root({
    method: "POST",
    url: "/api/v1/admin/extensions/orglevels/install",
    payload: { sha256: (up.json() as { sha256: string }).sha256 },
  });
  expect(inst.statusCode, inst.body).toBe(200);
  await waitFor(
    async () => host().current("orglevels")?.manifest.version === version,
    20_000,
    `orglevels ${version} loaded`,
  );
}

const host = () => k?.app.get(ExtensionHost) as ExtensionHost;
const effective = () => k?.app.get(EffectiveConfigs) as EffectiveConfigs;
const ovUrl = (orgId: string) => `/api/v1/orgs/${orgId}/extensions/orglevels/overrides`;

/** Saves platform values; this replica applies them before the call returns. */
async function platform(values: Record<string, unknown>): Promise<void> {
  const res = await root({
    method: "PUT",
    url: "/api/v1/admin/extensions/orglevels/config",
    payload: { values },
  });
  expect(res.statusCode, res.body).toBe(200);
  secretBodies.push(res.body);
}

async function getOverrides(orgId: string, req: Req = owner): Promise<OverrideView> {
  const res = await req({ method: "GET", url: ovUrl(orgId) });
  expect(res.statusCode, res.body).toBe(200);
  secretBodies.push(res.body);
  return res.json() as OverrideView;
}

async function save(orgId: string, values: Record<string, unknown>) {
  const res = await owner({ method: "PUT", url: ovUrl(orgId), payload: { values } });
  secretBodies.push(res.body);
  return res;
}

async function orgRow(orgId: string) {
  const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
  expect(res.statusCode, res.body).toBe(200);
  secretBodies.push(res.body);
  return (
    res.json() as {
      extensions: { plugin: string; overrideState: string; needsConfig: boolean }[];
    }
  ).extensions.find((e) => e.plugin === "orglevels");
}

const field = (v: OverrideView, path: string) => v.fields.find((f) => f.path === path);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  await truncateTables(db, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  await accounts.createLocal({
    login: "root",
    password: "correct horse battery",
    displayName: "R",
    superAdmin: true,
  });
  await accounts.createLocal({
    login: "owner",
    password: "correct horse battery",
    displayName: "O",
  });
  const mem = await accounts.createLocal({
    login: "mem",
    password: "correct horse battery",
    displayName: "M",
  });
  k = await boot();
  orgA = await createOrg(owner, "Alpha");
  orgB = await createOrg(owner, "Beta");
  orgC = await createOrg(owner, "Gamma");
  const ownerId = (
    await db.selectFrom("accounts").select("id").where("display_name", "=", "O").executeTakeFirst()
  )?.id as string;
  await testMembers(db).add(orgA, mem.id, "member", ownerId);
  await deployWithHost();
  await platform({ baseUrl: "https://p.example", apiKey: PK });
});

/** First install: the hidden `host` is required, so it loads once the platform saved it. */
async function deployWithHost(): Promise<void> {
  const up = await root({
    method: "POST",
    url: "/api/v1/admin/extensions/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(await packOf("orglevels")),
  });
  expect(up.statusCode, up.body).toBe(200);
  const sha256 = (up.json() as { sha256: string }).sha256;
  for (const [url, payload] of [
    ["/api/v1/admin/extensions/orglevels/install", { sha256 }],
    ["/api/v1/admin/extensions/orglevels/enable", undefined],
  ] as const) {
    const res = await root({ method: "POST", url, ...(payload && { payload }) });
    expect(res.statusCode, res.body).toBe(200);
  }
  await platform({ host: "h" });
  await waitFor(async () => host().current("orglevels"), 20_000, "orglevels loaded");
}

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("mergeCopy (the copy half of the effective config)", () => {
  const schema = z.object({
    host: z.string(),
    url: orgAccess(z.string(), "override"),
    key: orgAccess(secret(z.string().optional()), "override"),
    nested: orgAccess(
      z.object({ id: z.string(), token: secret(z.string()).optional() }),
      "override",
    ),
  });
  const platform = {
    host: "h",
    url: "p",
    key: "PLAT-key",
    nested: { id: "pid", token: "PLAT-tok" },
  };

  it("never falls back to a platform secret, even an optional one, also nested", () => {
    expect(mergeCopy(schema, platform, { config: { url: "o" }, secrets: {} })).toEqual({
      host: "h",
      url: "o",
      nested: { id: "pid" },
    });
    expect(JSON.stringify(mergeCopy(schema, platform, { config: {}, secrets: {} }))).not.toContain(
      "PLAT",
    );
  });

  it("uses the copy's own secrets and ignores copy values of keys that are not overridable", () => {
    expect(
      mergeCopy(schema, platform, {
        config: { url: "o", host: "evil", nested: { id: "oid", token: "smuggled" } },
        secrets: { key: "own-key", "nested.token": "own-tok" },
      }),
    ).toEqual({ host: "h", url: "o", key: "own-key", nested: { id: "oid", token: "own-tok" } });
  });
});

describe("org copies of overridable config", () => {
  it("1. GET overrides while following: platform values, secrets only as set, no hidden field; members refused", async () => {
    const v = await getOverrides(orgA);
    expect(v.state).toBe("following");
    expect(v).not.toHaveProperty("createdAt");
    expect(v.fields.map((f) => f.path)).toEqual(["limit", "baseUrl", "apiKey"]);
    expect(field(v, "baseUrl")).toEqual({
      path: "baseUrl",
      level: "override",
      secret: false,
      platform: { value: "https://p.example" },
    });
    expect(field(v, "limit")).toEqual({
      path: "limit",
      level: "readonly",
      secret: false,
      platform: { value: 5 },
    });
    expect(field(v, "apiKey")).toEqual({
      path: "apiKey",
      level: "override",
      secret: true,
      platform: { set: true },
    });
    expect(v).toMatchObject({ valid: true, issues: [] });
    // the form schema: read-only and overridable properties only, never a hidden one or a value
    expect(Object.keys(v.schema?.properties ?? {}).sort()).toEqual(["apiKey", "baseUrl", "limit"]);
    expect(v.schema?.required ?? []).not.toContain("host");
    expect(v.schema?.required).toEqual(expect.arrayContaining(["baseUrl", "apiKey"]));
    expect(v.schema?.properties?.apiKey?.["x-secret"]).toBe(true);
    expect(v.schema?.properties?.baseUrl?.["x-org"]).toBe("override");
    expect(JSON.stringify(v.schema)).not.toContain("host");
    expect(JSON.stringify(v.schema)).not.toContain("p.example");
    const res = await member({ method: "GET", url: ovUrl(orgA) });
    expect(res.statusCode).toBe(403);
    for (const [method, url, payload] of [
      ["PUT", ovUrl(orgA), { values: { baseUrl: "https://m.example" } }],
      ["DELETE", ovUrl(orgA), undefined],
      ["POST", `${ovUrl(orgA)}/take`, { paths: ["baseUrl"] }],
    ] as const) {
      const r = await member({ method, url, ...(payload && { payload }) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("an extension the org is not offered under plugin scope answers 404 on every override route", async () => {
    const itemId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "orglevels",
        package_name: "@test/plugin-orglevels",
        publisher: "Test",
        description: "Test",
        latest_version: "0.1.0",
        scope: "named",
      })
      .execute();
    await db
      .insertInto("extension_catalog_sources")
      .values({ plugin: "orglevels", item_id: itemId })
      .execute();
    await db
      .insertInto("catalog_item_scope_orgs")
      .values({ item_id: itemId, org_id: orgA })
      .execute();
    try {
      expect((await owner({ method: "GET", url: ovUrl(orgA) })).statusCode).toBe(200);
      for (const [method, url, payload] of [
        ["GET", ovUrl(orgB), undefined],
        ["PUT", ovUrl(orgB), { values: { baseUrl: "https://x.example", apiKey: OK } }],
        ["DELETE", ovUrl(orgB), undefined],
        ["POST", `${ovUrl(orgB)}/take`, { paths: ["baseUrl"] }],
      ] as const) {
        const r = await owner({ method, url, ...(payload && { payload }) });
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        expect(r.json().error.code).toBe("extension.not_found");
        secretBodies.push(r.body);
      }
      expect(await db.selectFrom("extension_org_overrides").selectAll().execute()).toEqual([]);
    } finally {
      await db.deleteFrom("catalog_item_scope_orgs").where("item_id", "=", itemId).execute();
      await db.deleteFrom("extension_catalog_sources").where("item_id", "=", itemId).execute();
      await db.deleteFrom("catalog_items").where("id", "=", itemId).execute();
    }
  });

  it("2. a first save that changes the endpoint but leaves the required secret empty is refused, naming it; nothing stored", async () => {
    const res = await save(orgA, { baseUrl: "https://o.example" });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("extension.config_invalid");
    expect(res.json().error.details.map((d: { path: string }) => d.path)).toEqual(["apiKey"]);
    expect(await db.selectFrom("extension_org_overrides").selectAll().execute()).toEqual([]);
    expect(
      await db
        .selectFrom("secrets")
        .select("key")
        .where("key", "like", "plugin-override:%")
        .execute(),
    ).toEqual([]);
  });

  it("3. a save with the org's own key makes a copy; the effective config is the copy's, other orgs keep the platform's", async () => {
    const res = await save(orgA, { baseUrl: "https://o.example", apiKey: OK });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json() as OverrideView;
    expect(v.state).toBe("copy");
    expect(typeof v.createdAt).toBe("string");
    expect(field(v, "apiKey")).toEqual({
      path: "apiKey",
      level: "override",
      secret: true,
      platform: { set: true },
      org: { set: true },
    });
    expect(await effective().get(orgA, "orglevels")).toEqual({
      ok: true,
      source: "copy",
      config: { host: "h", limit: 5, baseUrl: "https://o.example", apiKey: OK },
    });
    expect(await effective().get(orgB, "orglevels")).toEqual({
      ok: true,
      source: "platform",
      config: { host: "h", limit: 5, baseUrl: "https://p.example", apiKey: PK },
    });
    // stored: the non-secret values in the row, the key encrypted under the org
    const row = await db
      .selectFrom("extension_org_overrides")
      .select(["config"])
      .where("org_id", "=", orgA)
      .executeTakeFirstOrThrow();
    expect(row.config).toEqual({ baseUrl: "https://o.example" });
    expect(
      await db
        .selectFrom("secrets")
        .select(["org_id", "key"])
        .where("key", "like", "plugin-override:%")
        .execute(),
    ).toEqual([{ org_id: orgA, key: "plugin-override:orglevels:apiKey" }]);
    expect((await orgRow(orgA))?.overrideState).toBe("copy");
    expect((await orgRow(orgB))?.overrideState).toBe("following");
  });

  it("an effective config read of a copy never falls back to a platform secret, even an optional one", async () => {
    // a copy row without its secret (as after the platform made apiKey optional in a later version)
    await db
      .deleteFrom("secrets")
      .where("org_id", "=", orgA)
      .where("key", "=", "plugin-override:orglevels:apiKey")
      .execute();
    await effective().invalidate(orgA, "orglevels");
    const r = await effective().get(orgA, "orglevels");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(PK);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(["apiKey"]);
    expect((await orgRow(orgA))?.needsConfig).toBe(true);
    // put the key back through the API (a save of the secret alone)
    const res = await save(orgA, { apiKey: OK });
    expect(res.statusCode, res.body).toBe(200);
    expect(await effective().get(orgA, "orglevels")).toMatchObject({ ok: true });
  });

  it("4. platform changes reach following orgs only; GET marks the differing field", async () => {
    await platform({ baseUrl: "https://p2.example" });
    expect(await effective().get(orgA, "orglevels")).toMatchObject({
      config: { baseUrl: "https://o.example" },
    });
    expect(await effective().get(orgB, "orglevels")).toMatchObject({
      source: "platform",
      config: { baseUrl: "https://p2.example" },
    });
    const v = await getOverrides(orgA);
    expect(field(v, "baseUrl")).toEqual({
      path: "baseUrl",
      level: "override",
      secret: false,
      platform: { value: "https://p2.example" },
      org: { value: "https://o.example" },
      differs: true,
    });
    expect(field(v, "apiKey")).not.toHaveProperty("differs");
  });

  it("5. take copies the platform's current value into the copy; a secret cannot be taken", async () => {
    const res = await owner({
      method: "POST",
      url: `${ovUrl(orgA)}/take`,
      payload: { paths: ["baseUrl"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    secretBodies.push(res.body);
    const v = res.json() as OverrideView;
    expect(v.state).toBe("copy");
    expect(field(v, "baseUrl")).toMatchObject({
      org: { value: "https://p2.example" },
      differs: false,
    });
    expect(await effective().get(orgA, "orglevels")).toMatchObject({
      source: "copy",
      config: { baseUrl: "https://p2.example", apiKey: OK },
    });
    const secret = await owner({
      method: "POST",
      url: `${ovUrl(orgA)}/take`,
      payload: { paths: ["apiKey"] },
    });
    expect(secret.statusCode, secret.body).toBe(400);
    expect(secret.json().error.code).toBe("extension.field_not_overridable");
    // a following org has nothing to take into
    const none = await owner({
      method: "POST",
      url: `${ovUrl(orgB)}/take`,
      payload: { paths: ["baseUrl"] },
    });
    expect(none.statusCode, none.body).toBe(404);
    expect(none.json().error.code).toBe("extension.no_org_override");
  });

  it("6. read-only and hidden fields cannot be saved", async () => {
    for (const values of [{ limit: 9 }, { host: "x" }, { nope: 1 }]) {
      const res = await save(orgA, values);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("extension.field_not_overridable");
    }
  });

  it("7. DELETE drops the copy and its secrets; the org follows the platform again; save, take and reset are audited", async () => {
    // a read that started before the reset and caches its (old) copy after the reset committed:
    // simulated by caching the copy now and writing that entry back after the reset
    expect(await effective().get(orgA, "orglevels")).toMatchObject({ source: "copy" });
    const redis = new Redis(rd.url);
    const stale = new Map<string, string>();
    for (const key of await redis.keys(`cache:effective-config:${orgA}:orglevels:*`)) {
      stale.set(key, (await redis.get(key)) as string);
    }
    expect(stale.size).toBe(1);
    const res = await owner({ method: "DELETE", url: ovUrl(orgA) });
    for (const [key, v] of stale) await redis.set(key, v, "EX", 300);
    redis.disconnect();
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as OverrideView).state).toBe("following");
    expect(await effective().get(orgA, "orglevels")).toEqual({
      ok: true,
      source: "platform",
      config: { host: "h", limit: 5, baseUrl: "https://p2.example", apiKey: PK },
    });
    expect(
      await db
        .selectFrom("secrets")
        .select("key")
        .where("org_id", "=", orgA)
        .where("key", "like", "plugin-override:orglevels:%")
        .execute(),
    ).toEqual([]);
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "org_id", "target", "detail"])
      .where("action", "like", "extension.org_override_%")
      .orderBy("at")
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      "extension.org_override_saved",
      "extension.org_override_saved",
      "extension.org_override_taken",
      "extension.org_override_reset",
    ]);
    expect(audits.every((a) => a.org_id === orgA && a.target === "orglevels")).toBe(true);
    expect(audits[0]?.detail).toEqual({ changedPaths: ["apiKey", "baseUrl"] });
    expect(JSON.stringify(audits)).not.toContain(OK);
    const again = await owner({ method: "DELETE", url: ovUrl(orgA) });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("extension.no_org_override");
  });

  it("a first save whose key equals the platform's still audits the key as changed (no guess oracle)", async () => {
    const res = await save(orgC, { baseUrl: "https://c.example", apiKey: PK });
    expect(res.statusCode, res.body).toBe(200);
    const row = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "extension.org_override_saved")
      .where("org_id", "=", orgC)
      .executeTakeFirstOrThrow();
    expect(row.detail).toEqual({ changedPaths: ["apiKey", "baseUrl"] });
    // a later save of the same key compares with the copy's own key only: unchanged
    const same = await save(orgC, { apiKey: PK });
    expect(same.statusCode, same.body).toBe(200);
    const rows = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "extension.org_override_saved")
      .where("org_id", "=", orgC)
      .orderBy("at")
      .execute();
    expect(rows[1]?.detail).toEqual({ changedPaths: [] });
    expect((await owner({ method: "DELETE", url: ovUrl(orgC) })).statusCode).toBe(200);
  });

  it("8. a platform without the overridable values: following orgs need config and are counted until they bring a copy", async () => {
    await platform({ baseUrl: null, apiKey: null });
    const on = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgB}/extensions/orglevels`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(await orgRow(orgB)).toMatchObject({ overrideState: "following", needsConfig: true });
    const r = await effective().get(orgB, "orglevels");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path).sort()).toEqual(["apiKey", "baseUrl"]);
    // orgA follows too but has the extension off: only orgs where it is on count
    expect(await effective().countNeedingConfig("orglevels")).toBe(1);
    const admin1 = await root({ method: "GET", url: "/api/v1/admin/extensions/orglevels" });
    expect(admin1.json()).toMatchObject({ status: "enabled", orgsNeedingConfig: 1 });

    const res = await save(orgB, { baseUrl: "https://o.example", apiKey: OK2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await orgRow(orgB)).toMatchObject({ overrideState: "copy", needsConfig: false });
    expect(await effective().countNeedingConfig("orglevels")).toBe(0);
    const admin2 = await root({ method: "GET", url: "/api/v1/admin/extensions/orglevels" });
    expect(admin2.json()).toMatchObject({ orgsNeedingConfig: 0 });
  });

  it("10. the admin lists the orgs with a copy: differing fields and whether secrets are set, never a value", async () => {
    const res = await root({
      method: "GET",
      url: "/api/v1/admin/extensions/orglevels/org-overrides",
    });
    expect(res.statusCode, res.body).toBe(200);
    secretBodies.push(res.body);
    expect(res.json()).toEqual({
      overrides: [
        {
          orgId: orgB,
          orgName: "Beta",
          createdAt: expect.any(String),
          differing: ["baseUrl"],
          secrets: [{ path: "apiKey", set: true }],
        },
      ],
    });
    const asOwner = await owner({
      method: "GET",
      url: "/api/v1/admin/extensions/orglevels/org-overrides",
    });
    expect(asOwner.statusCode).toBe(403);
  });

  it("12. disabling the extension on the deployment and enabling it again keeps the copy", async () => {
    const off = await root({ method: "POST", url: "/api/v1/admin/extensions/orglevels/disable" });
    expect(off.statusCode, off.body).toBe(200);
    await waitFor(async () => !host().current("orglevels"), 20_000, "orglevels unloaded");
    expect(await db.selectFrom("extension_org_overrides").select("org_id").execute()).toEqual([
      { org_id: orgB },
    ]);
    const on = await root({ method: "POST", url: "/api/v1/admin/extensions/orglevels/enable" });
    expect(on.statusCode, on.body).toBe(200);
    await waitFor(async () => host().current("orglevels"), 20_000, "orglevels loaded again");
    expect((await getOverrides(orgB)).state).toBe("copy");
    expect(await effective().get(orgB, "orglevels")).toMatchObject({
      ok: true,
      config: { baseUrl: "https://o.example", apiKey: OK2 },
    });
  });

  it("9. a field that stops being overridable is ignored in old copies; a copy invalid after an upgrade makes only its org need config", async () => {
    await platform({ baseUrl: "https://p3.example", apiKey: PK });
    const a = await save(orgA, { baseUrl: "https://a.example", apiKey: SHORT });
    expect(a.statusCode, a.body).toBe(200);
    await deploy("orglevels-v2", "0.2.0");
    // orgB's copy still holds baseUrl, which is now hidden: the platform's value applies; the
    // transforms of 0.2.0 ran exactly once (host "h!", tags split once)
    expect(await effective().get(orgB, "orglevels")).toEqual({
      ok: true,
      source: "copy",
      config: {
        host: "h!",
        tags: ["a", "b"],
        limit: 5,
        baseUrl: "https://p3.example",
        apiKey: OK2,
      },
    });
    expect(await effective().get(orgC, "orglevels")).toMatchObject({
      ok: true,
      source: "platform",
      config: { host: "h!", tags: ["a", "b"] },
    });
    const vb = await getOverrides(orgB);
    expect(vb).toMatchObject({ state: "copy", valid: true });
    expect(vb.fields.map((f) => f.path)).toEqual(["limit", "apiKey"]);
    // orgA's key is too short for 0.2.0: only orgA needs config
    const ra = await effective().get(orgA, "orglevels");
    expect(ra.ok).toBe(false);
    expect((await orgRow(orgA))?.needsConfig).toBe(true);
    expect((await orgRow(orgB))?.needsConfig).toBe(false);
    expect(await orgRow(orgC)).toMatchObject({ overrideState: "following", needsConfig: false });
    const va = await getOverrides(orgA);
    expect(va.valid).toBe(false);
    expect(va.issues.map((i) => i.path)).toEqual(["apiKey"]);
  });

  it("11. a platform value fixed by the startup config is read-only on the platform form; an org can still override it", async () => {
    await deploy("orglevels", "0.1.0");
    await k?.close();
    k = undefined;
    k = await boot({ CAPYBARA_EXTENSION_CONFIG__ORGLEVELS__BASE_URL: "https://env.example" });
    await waitFor(async () => host().current("orglevels"), 20_000, "orglevels loaded");
    const cfg = await root({ method: "GET", url: "/api/v1/admin/extensions/orglevels/config" });
    expect(cfg.statusCode, cfg.body).toBe(200);
    secretBodies.push(cfg.body);
    expect(
      (cfg.json() as { fields: { path: string }[] }).fields.find((f) => f.path === "baseUrl"),
    ).toMatchObject({
      source: "env",
      readonly: true,
      org: "override",
      value: "https://env.example",
    });
    const res = await save(orgA, { baseUrl: "https://a2.example", apiKey: LONG });
    expect(res.statusCode, res.body).toBe(200);
    expect(await effective().get(orgA, "orglevels")).toMatchObject({
      ok: true,
      config: { baseUrl: "https://a2.example", apiKey: LONG },
    });
    expect(await effective().get(orgC, "orglevels")).toMatchObject({
      source: "platform",
      config: { baseUrl: "https://env.example", apiKey: PK },
    });
  });

  it("no org or admin response carried a secret value", () => {
    const all = secretBodies.join("\n");
    for (const s of [PK, OK, OK2, SHORT, LONG]) expect(all).not.toContain(s);
    expect(secretBodies.length).toBeGreaterThan(20);
  });
});
