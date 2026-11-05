import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
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
      extensions: [fx("fixture"), fx("orgcfg")],
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
}, 120_000);
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

async function createOrg(req: Req): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

const body = { enabled: true, config: { appId: "app-1", appSecret: SECRET } };

describe("组织插件配置 HTTP", () => {
  it("the application provides OrgExtensionConfigs; host.manifests() in load order", () => {
    expect(
      k.app
        .get(ExtensionHost)
        .manifests()
        .map((m) => m.name),
    ).toEqual(["fixture", "orgcfg"]);
    expect(typeof k.app.get(OrgExtensionConfigs).list).toBe("function");
  });

  it("admin PUT 200、GET 列出；响应体、审计与日志都不含密钥值", async () => {
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
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      extension: {
        plugin: "orgcfg",
        version: "1.2.3",
        enabled: true,
        configurable: true,
        config: { appId: "app-1", webhook: { path: "/hook" } },
        secrets: [
          { path: "appSecret", set: true },
          { path: "webhook.token", set: false },
        ],
      },
    });
    expect(put.body).not.toContain(SECRET);

    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(list.statusCode).toBe(200);
    const plugins = (list.json() as { extensions: { plugin: string }[] }).extensions;
    expect(plugins.map((p) => p.plugin)).toEqual(["fixture", "orgcfg"]);
    expect(list.body).not.toContain(SECRET);

    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("action", "=", "org.plugin_config.updated")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_account_id).toBe(admin.id);
    expect(JSON.stringify(audits[0]?.detail)).not.toContain(SECRET);

    expect(await k.app.get(OrgExtensionConfigs).get(orgId, "orgcfg")).toMatchObject({
      config: { appSecret: SECRET },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("member → 403；非成员 → 404；服务令牌（admin 角色）→ 403", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const m = await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    await members.add(orgId, m.id, "member", owner.id);
    const memReq = await session("mem");
    const a = await memReq({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(a.statusCode).toBe(403);
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
  });

  it("错误码：未加载插件 404、无 org schema 传 config 400、配置不合法 400 带 details、未知字段 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const nf = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/nope`,
      payload: { enabled: true },
    });
    expect(nf.statusCode).toBe(404);
    expect(errCode(nf)).toBe("extension.not_found");
    const noCfg = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fixture`,
      payload: { config: { a: 1 } },
    });
    expect(noCfg.statusCode).toBe(400);
    expect(errCode(noCfg)).toBe("extension.no_org_config");
    const bad = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: { config: { appId: 1, appSecret: SECRET } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "extension.config_invalid", details: [{ path: "appId" }] },
    });
    expect(bad.body).not.toContain(SECRET);
    const extra = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
      payload: { enabled: true, bogus: 1 },
    });
    expect(extra.statusCode).toBe(400);
    expect(errCode(extra)).toBe("validation_failed");
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
      expect(out.map((e) => e.plugin)).toEqual(["orgcfg"]);
      expect(out[0]).toMatchObject({ catalogItem: { scope: "named" }, switchable: true });
      await db
        .updateTable("catalog_items")
        .set({ scope: "optional" })
        .where("id", "=", itemId)
        .execute();
      expect((await list()).map((e) => e.plugin)).toEqual(["fixture", "orgcfg"]);
    });

    it("enabled:false on an all plugin is plugin.scope_locked; an extension without an item is unchanged", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      await seedItem("orgcfg", "all");
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

    it("an extension sourced from several items: an all item locks it on; any item offered makes it visible", async () => {
      const req = await session("owner");
      const orgId = await createOrg(req);
      await seedItem("orgcfg", "optional", [], false, "orgcfg-a");
      await seedItem("orgcfg", "all", [], false, "orgcfg-b");
      const locked = await req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/orgcfg`,
        payload: { enabled: false },
      });
      expect(locked.statusCode).toBe(409);
      expect(errCode(locked)).toBe("plugin.scope_locked");
      const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
      expect(
        (list.json() as { extensions: Record<string, unknown>[] }).extensions.find(
          (e) => e.plugin === "orgcfg",
        ),
      ).toMatchObject({ switchable: false, catalogItem: { scope: "all" } });
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
        enterpriseAdmin: true,
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
