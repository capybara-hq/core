import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { testMembers } from "../helpers/members.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
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
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      log: { level: "debug" },
      plugins: [fx("fixture"), fx("orgcfg")],
      pluginPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("debug", { write: (l) => lines.push(l) }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = testMembers(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
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
  it("Kernel exposes orgExtensionConfigs; host.manifests() in load order", () => {
    expect(k.host.manifests().map((m) => m.name)).toEqual(["fixture", "orgcfg"]);
    expect(typeof k.orgExtensionConfigs.list).toBe("function");
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

    expect(await k.orgExtensionConfigs.get(orgId, "orgcfg")).toMatchObject({
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
});
