import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;
let owner: Account;
const lines: string[] = [];

const PW = "correct horse battery";
const SECRET = "http-s3cr3t-0a1b2c";
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      log: { level: "debug" },
      extensions: [fx("fixture"), fx("orgcfg"), fakeExtensionEntry("fake-web")],
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("debug", { write: (l) => lines.push(l) }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  tokens = apiTokensFor(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.catalog_items, capybara.extension_catalog_sources",
  );
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Req = ReturnType<typeof asUser>;

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function createOrg(req: Req, name = "Acme"): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

const body = { enabled: true };

describe("org extension HTTP", () => {
  it("the application provides OrgExtensionConfigs; host.manifests() in load order", () => {
    expect(
      k.app
        .get(ExtensionHost)
        .manifests()
        .map((m) => m.name),
    ).toEqual(["fixture", "orgcfg", "fake-web"]);
    expect(typeof k.app.get(OrgExtensionConfigs).list).toBe("function");
  });

  it("admin PUT 200 (enablement only), GET lists; audited by the actor; no config in the view", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const admin = await accounts.createLocal({ login: "adm", password: PW, displayName: "Adm" });
    await members.add(orgId, admin.id, "admin", owner.id);
    const req = await session("adm");

    const put = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: body,
    });
    expect(put.statusCode, put.body).toBe(200);
    const ext = (put.json() as { extension: Record<string, unknown> }).extension;
    expect(ext).toMatchObject({
      plugin: "orgcfg",
      version: "1.2.3",
      enabled: true,
      configurable: true,
      overrideState: "following",
      // its required overridable fields are empty on the platform and the org has no copy
      needsConfig: true,
    });
    for (const f of ["config", "secrets", "orgConfigSchema"]) expect(ext).not.toHaveProperty(f);

    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(list.statusCode).toBe(200);
    const plugins = (list.json() as { extensions: { plugin: string }[] }).extensions;
    expect(plugins.map((p) => p.plugin)).toEqual(["fixture", "orgcfg", "fake-web"]);

    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("action", "=", "org.plugin_config.updated")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_account_id).toBe(admin.id);
    expect(audits[0]?.detail).toEqual({ enabled: true });
  });

  it("a web provider whose platform key is empty needs config until the org saves its copy", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const on = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-web`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const view = async () =>
      (
        (await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` })).json() as {
          extensions: Record<string, unknown>[];
        }
      ).extensions.find((e) => e.plugin === "fake-web");
    expect(await view()).toMatchObject({
      enabled: true,
      configurable: true,
      overrideState: "following",
      needsConfig: true,
    });
    const save = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-web/overrides`,
      payload: { values: { token: SECRET } },
    });
    expect(save.statusCode, save.body).toBe(200);
    expect(save.body).not.toContain(SECRET);
    expect(await view()).toMatchObject({
      enabled: true,
      configurable: true,
      overrideState: "copy",
      needsConfig: false,
    });
    // another org still follows the empty platform key
    const other = await createOrg(req, "Beta");
    await req({
      method: "PUT",
      url: `/api/v1/orgs/${other}/extensions/fake-web`,
      payload: { enabled: true },
    });
    const otherView = (
      (await req({ method: "GET", url: `/api/v1/orgs/${other}/extensions` })).json() as {
        extensions: Record<string, unknown>[];
      }
    ).extensions.find((e) => e.plugin === "fake-web");
    expect(otherView).toMatchObject({ overrideState: "following", needsConfig: true });
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("member reads the list without config, secrets, schema or permissions; guest 403; PUT 403", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const put = await ownerReq({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: body,
    });
    expect(put.statusCode).toBe(200);
    const m = await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    await members.add(orgId, m.id, "member", owner.id);
    const memReq = await session("mem");
    const a = await memReq({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(a.statusCode).toBe(200);
    const list = (a.json() as { extensions: Record<string, unknown>[] }).extensions;
    expect(list.map((e) => e.plugin)).toEqual(["fixture", "orgcfg", "fake-web"]);
    for (const e of list) {
      for (const f of ["config", "secrets", "orgConfigSchema", "permissions"])
        expect(e).not.toHaveProperty(f);
      // the extension point names only: what the 扩展 page sorts by capability
      expect(e.provides).toEqual(expect.any(Array));
      expect(e).toMatchObject({ enabled: expect.any(Boolean), version: expect.any(String) });
    }
    // the admin keeps the full view
    const adminList = await ownerReq({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    const full = (adminList.json() as { extensions: Record<string, unknown>[] }).extensions;
    // members get the same points the admin's permission list names
    for (const e of full) {
      const groups = e.permissions as { category: string; items: string[] }[];
      const points = groups.filter((g) => g.category === "provides").flatMap((g) => g.items);
      expect(e.provides).toEqual(points);
      expect(list.find((x) => x.plugin === e.plugin)?.provides).toEqual(points);
    }
    expect(full.some((e) => (e.provides as string[]).length > 0)).toBe(true);
    expect(full.find((e) => e.plugin === "orgcfg")).toMatchObject({
      permissions: expect.any(Array),
      configurable: true,
    });

    // guests read nothing of the catalog or skills either: member is the floor
    const g = await accounts.createLocal({ login: "gst", password: PW, displayName: "G" });
    await members.add(orgId, g.id, "guest", owner.id);
    const gReq = await session("gst");
    expect(
      (await gReq({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` })).statusCode,
    ).toBe(403);

    const b = await memReq({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: body,
    });
    expect(b.statusCode).toBe(403);
    expect(errCode(b)).toBe("forbidden");

    await accounts.createLocal({ login: "out", password: PW, displayName: "O" });
    const outReq = await session("out");
    const c = await outReq({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("org.not_found");

    const { token } = await tokens.createService(orgId, {
      name: "svc",
      role: "admin",
      createdBy: owner.id,
    });
    const d = await k.http.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(d.statusCode).toBe(403);
    // the read action is not a service-token action either
    const e = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/extensions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(e.statusCode).toBe(403);
  });

  it("errors: an unloaded extension 404; config or any other unknown field in the body 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const nf = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/nope`,
      payload: { enabled: true },
    });
    expect(nf.statusCode).toBe(404);
    expect(errCode(nf)).toBe("extension.not_found");
    // the org config is the org's copy (`…/overrides`): the body is strict
    for (const ext of ["fixture", "orgcfg"]) {
      const withConfig = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/${ext}`,
        payload: { enabled: true, config: { appId: "x", appSecret: SECRET } },
      });
      expect(withConfig.statusCode).toBe(400);
      expect(errCode(withConfig)).toBe("validation_failed");
      expect(withConfig.body).not.toContain(SECRET);
    }
    const extra = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: { enabled: true, bogus: 1 },
    });
    expect(extra.statusCode).toBe(400);
    expect(errCode(extra)).toBe("validation_failed");
    expect(
      await db
        .selectFrom("extension_org_configs")
        .select("plugin")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([]);
  });

  describe("plugin scope", () => {
    /** A live catalog item of the extension (its source), with the scope and the listed orgs. */
    async function seedItem(
      plugin: string,
      scope: "all" | "optional" | "named",
      orgs: string[] = [],
      builtin = false,
      itemName = plugin,
    ): Promise<string> {
      const id = randomUUID();
      await db
        .insertInto("catalog_items")
        .values({
          id,
          name: itemName,
          package_name: `@acme/plugin-${itemName}`,
          publisher: "Acme",
          description: "Test",
          latest_version: "1.0.0",
          scope,
          builtin,
        })
        .execute();
      await db.insertInto("extension_catalog_sources").values({ plugin, item_id: id }).execute();
      if (orgs.length > 0) {
        await db
          .insertInto("catalog_item_scope_orgs")
          .values(orgs.map((org_id) => ({ item_id: id, org_id })))
          .execute();
      }
      return id;
    }

    it("a named plugin's extension is absent for an org not on its list, present for one that is", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      await seedItem("orgcfg", "named", [orgId]);
      const itemId = await seedItem("fixture", "named", []);
      const list = async () =>
        (
          (await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` })).json() as {
            extensions: {
              plugin: string;
              catalogItem: { scope: string } | null;
              switchable: boolean;
            }[];
          }
        ).extensions;
      const out = await list();
      expect(out.map((e) => e.plugin)).toEqual(["orgcfg", "fake-web"]);
      expect(out[0]).toMatchObject({ catalogItem: { scope: "named" }, switchable: true });
      await db
        .updateTable("catalog_items")
        .set({ scope: "optional" })
        .where("id", "=", itemId)
        .execute();
      expect((await list()).map((e) => e.plugin)).toEqual(["fixture", "orgcfg", "fake-web"]);
    });

    it("enabled:false on an all plugin records the switch off, on a builtin one is plugin.scope_locked; an extension without an item is unchanged", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      const itemId = await seedItem("orgcfg", "all");
      const view = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
      expect(
        (view.json() as { extensions: { plugin: string }[] }).extensions.find(
          (e) => e.plugin === "orgcfg",
        ),
      ).toMatchObject({ catalogItem: { scope: "all" }, switchable: true });
      const off = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
        payload: { enabled: false },
      });
      expect(off.statusCode, off.body).toBe(200);
      expect(
        await db
          .selectFrom("catalog_item_org_switches")
          .select("enabled")
          .where("item_id", "=", itemId)
          .where("org_id", "=", orgId)
          .executeTakeFirst(),
      ).toEqual({ enabled: false });
      await db
        .updateTable("catalog_items")
        .set({ builtin: true })
        .where("id", "=", itemId)
        .execute();
      const locked = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
        payload: { enabled: false },
      });
      expect(locked.statusCode).toBe(409);
      expect(errCode(locked)).toBe("plugin.scope_locked");
      const direct = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/fixture`,
        payload: { enabled: true },
      });
      expect(direct.statusCode).toBe(200);
      expect(direct.json()).toMatchObject({
        extension: { plugin: "fixture", enabled: true, catalogItem: null, switchable: true },
      });
    });

    it("an extension sourced from several items: a builtin item locks it on, an all one does not; any item offered makes it visible", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      await seedItem("orgcfg", "optional", [], false, "orgcfg-a");
      const allId = await seedItem("orgcfg", "all", [], false, "orgcfg-b");
      const entry = async () =>
        (
          (await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` })).json() as {
            extensions: Record<string, unknown>[];
          }
        ).extensions.find((e) => e.plugin === "orgcfg");
      expect(await entry()).toMatchObject({ switchable: true });
      await db
        .updateTable("catalog_items")
        .set({ builtin: true })
        .where("id", "=", allId)
        .execute();
      const locked = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
        payload: { enabled: false },
      });
      expect(locked.statusCode).toBe(409);
      expect(errCode(locked)).toBe("plugin.scope_locked");
      expect(await entry()).toMatchObject({ switchable: false, catalogItem: { scope: "all" } });
      // named without the org + optional: visible through the optional one
      await seedItem("fixture", "named", [], false, "fixture-a");
      await seedItem("fixture", "optional", [], false, "fixture-b");
      const again = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
      expect(
        (again.json() as { extensions: { plugin: string }[] }).extensions.map((e) => e.plugin),
      ).toContain("fixture");
    });

    it("optional: enabled:false records the switch off (no install to preview)", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      const itemId = await seedItem("orgcfg", "optional");
      const r = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
        payload: { enabled: false },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(
        await db
          .selectFrom("catalog_item_org_switches")
          .select("enabled")
          .where("item_id", "=", itemId)
          .executeTakeFirst(),
      ).toEqual({ enabled: false });
    });

    it("the admin list reports scope, enabledOrgs and builtin", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      await seedItem("orgcfg", "optional");
      await db
        .insertInto("extension_org_configs")
        .values({ plugin: "orgcfg", org_id: orgId, enabled: true, config: null })
        .execute();
      await accounts.createLocal({
        login: "root",
        password: PW,
        displayName: "Root",
        superAdmin: true,
      });
      const root = await session("root");
      const res = await root({ method: "GET", url: "/api/v1/admin/extensions" });
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { extensions: Record<string, unknown>[] }).extensions;
      expect(items.find((e) => e.name === "orgcfg")).toMatchObject({
        scope: "optional",
        enabledOrgs: 1,
        builtin: false,
      });
      expect(items.find((e) => e.name === "fixture")).toMatchObject({
        scope: null,
        enabledOrgs: 0,
      });
    });
  });
});
