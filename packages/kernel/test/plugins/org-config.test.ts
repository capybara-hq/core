import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { type Org, OrgsService } from "../../src/orgs/orgs.service.js";
import { PluginHost } from "../../src/plugins/host.js";
import { OrgPluginConfigs } from "../../src/plugins/org-config.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let host: PluginHost;
let svc: OrgPluginConfigs;
let accounts: AccountsService;
let orgs: OrgsService;
let members: MembersService;
let A: Account;
let B: Account;
let org: Org;
let org2: Org;

const PW = "correct horse battery";
const SECRET = "s3cr3t-app-value-9f2a";
const TOKEN = "tok-hook-value-77c1";
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const silent = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  const keyring = createKeyring(Buffer.alloc(32, 3), []);
  const deps: KernelDeps = {
    db: raw,
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring,
    runWorkers: false,
    log: silent,
  };
  host = new PluginHost(deps, {});
  await host.load([fx("fixture"), fx("orgcfg")]);
  svc = new OrgPluginConfigs(db, keyring, host);
  accounts = new AccountsService(db);
  orgs = new OrgsService(db, new SettingsService(db), new ApiTokenService(db));
  members = new MembersService(db);
}, 120_000);
afterAll(async () => {
  await host?.close();
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  A = await accounts.createLocal({ login: "usera", password: PW, displayName: "A" });
  B = await accounts.createLocal({ login: "userb", password: PW, displayName: "B" });
  org = await orgs.create({ name: "Acme", slug: "acme" }, A);
  org2 = await orgs.create({ name: "Beta", slug: "beta" }, B);
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
};

const full = { appId: "app-1", appSecret: SECRET, webhook: { token: TOKEN, path: "/h" } };

describe("OrgPluginConfigs", () => {
  it("put 完整配置后 get 返回解密后的完整对象；list 不含密钥字段", async () => {
    const view = await svc.put(org.id, "orgcfg", { enabled: true, config: full }, A.id);
    expect(view).toMatchObject({ plugin: "orgcfg", version: "1.2.3", enabled: true });
    expect(await svc.get(org.id, "orgcfg")).toEqual({ enabled: true, config: full });

    const list = await svc.list(org.id);
    expect(list.map((v) => v.plugin)).toEqual(["fixture", "orgcfg"]);
    const fixture = list.find((v) => v.plugin === "fixture");
    expect(fixture).toEqual({
      plugin: "fixture",
      version: "0.1.0",
      enabled: false,
      configurable: false,
      config: null,
      secrets: [],
    });
    const v = list.find((x) => x.plugin === "orgcfg");
    expect(v?.configurable).toBe(true);
    expect(v?.config).toEqual({ appId: "app-1", webhook: { path: "/h" } });
    expect(v?.secrets).toEqual([
      { path: "appSecret", set: true },
      { path: "webhook.token", set: true },
    ]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it("未设置的可选密钥：secrets.set 为 false；默认值写入非密钥部分", async () => {
    await svc.put(org.id, "orgcfg", { config: { appId: "a", appSecret: SECRET } }, A.id);
    const v = (await svc.list(org.id)).find((x) => x.plugin === "orgcfg");
    expect(v?.enabled).toBe(false);
    expect(v?.config).toEqual({ appId: "a", webhook: { path: "/hook" } });
    expect(v?.secrets).toEqual([
      { path: "appSecret", set: true },
      { path: "webhook.token", set: false },
    ]);
  });

  it("库中 config 不含密钥明文；capybara.secrets 有对应行且密文不含明文", async () => {
    await svc.put(org.id, "orgcfg", { config: full }, A.id);
    const row = await sql<{
      t: string;
    }>`select config::text as t from capybara.plugin_org_configs where org_id = ${org.id}`.execute(
      raw,
    );
    expect(row.rows[0]?.t).toContain("app-1");
    expect(row.rows[0]?.t).not.toContain(SECRET);
    expect(row.rows[0]?.t).not.toContain(TOKEN);
    const secrets = await db
      .selectFrom("secrets")
      .select(["namespace", "key", "ciphertext"])
      .where("org_id", "=", org.id)
      .orderBy("key")
      .execute();
    expect(secrets.map((s) => [s.namespace, s.key])).toEqual([
      ["kernel", "plugin-config:orgcfg:appSecret"],
      ["kernel", "plugin-config:orgcfg:webhook.token"],
    ]);
    for (const s of secrets) {
      const buf = Buffer.from(s.ciphertext);
      expect(buf.includes(Buffer.from(SECRET))).toBe(false);
      expect(buf.includes(Buffer.from(TOKEN))).toBe(false);
    }
  });

  it("不传密钥字段 = 保留原值；null 清除必填密钥 → config_invalid 且原值未删", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true, config: full }, A.id);
    await svc.put(org.id, "orgcfg", { config: { appId: "app-2", webhook: {} } }, A.id);
    expect(await svc.get(org.id, "orgcfg")).toEqual({
      enabled: true,
      config: { appId: "app-2", appSecret: SECRET, webhook: { token: TOKEN, path: "/hook" } },
    });

    const err = await codeOf(
      svc.put(org.id, "orgcfg", { config: { appId: "app-3", appSecret: null } }, A.id),
    );
    expect(err.code).toBe("plugin.config_invalid");
    const details = err.details as { path: string; message: string }[];
    expect(details[0]?.path).toBe("appSecret");
    expect(typeof details[0]?.message).toBe("string");
    const after = await svc.get(org.id, "orgcfg");
    expect(after?.config).toMatchObject({ appId: "app-2", appSecret: SECRET });
  });

  it("null 清除可选密钥：secrets 行被删除", async () => {
    await svc.put(org.id, "orgcfg", { config: full }, A.id);
    await svc.put(org.id, "orgcfg", { config: { appId: "x", webhook: { token: null } } }, A.id);
    expect((await svc.get(org.id, "orgcfg"))?.config).toEqual({
      appId: "x",
      appSecret: SECRET,
      webhook: { path: "/hook" },
    });
    const keys = await db
      .selectFrom("secrets")
      .select("key")
      .where("org_id", "=", org.id)
      .execute();
    expect(keys.map((k) => k.key)).toEqual(["plugin-config:orgcfg:appSecret"]);
  });

  it("校验错误的 details 不含字段值", async () => {
    const err = await codeOf(
      svc.put(org.id, "orgcfg", { config: { appId: 424242, appSecret: SECRET } }, A.id),
    );
    expect(err.code).toBe("plugin.config_invalid");
    const text = JSON.stringify(err.details);
    expect(text).toContain("appId");
    expect(text).not.toContain("424242");
    expect(text).not.toContain(SECRET);
  });

  it("两个组织各自配置互不可见", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true, config: full }, A.id);
    await svc.put(
      org2.id,
      "orgcfg",
      { config: { appId: "beta-app", appSecret: "beta-secret" } },
      B.id,
    );
    expect((await svc.get(org.id, "orgcfg"))?.config).toMatchObject({ appSecret: SECRET });
    expect(await svc.get(org2.id, "orgcfg")).toEqual({
      enabled: false,
      config: { appId: "beta-app", appSecret: "beta-secret", webhook: { path: "/hook" } },
    });
    const other = await accounts.createLocal({ login: "userc", password: PW, displayName: "C" });
    const org3 = await orgs.create({ name: "Gamma", slug: "gamma" }, other);
    expect(await svc.get(org3.id, "orgcfg")).toBeUndefined();
    expect((await svc.list(org3.id)).find((v) => v.plugin === "orgcfg")).toMatchObject({
      enabled: false,
      config: null,
      secrets: [
        { path: "appSecret", set: false },
        { path: "webhook.token", set: false },
      ],
    });
  });

  it("未加载的插件 → plugin.not_found；无 org schema 传 config → no_org_config，只传 enabled 成功", async () => {
    expect((await codeOf(svc.put(org.id, "nope", { enabled: true }, A.id))).code).toBe(
      "plugin.not_found",
    );
    expect(
      (await codeOf(svc.put(org.id, "fixture", { enabled: true, config: {} }, A.id))).code,
    ).toBe("plugin.no_org_config");
    const v = await svc.put(org.id, "fixture", { enabled: true }, A.id);
    expect(v).toMatchObject({ plugin: "fixture", enabled: true, configurable: false });
    expect(await svc.get(org.id, "fixture")).toEqual({ enabled: true, config: null });
  });

  it("有 org schema 但未提供有效配置时不能启用；关闭不校验", async () => {
    expect((await codeOf(svc.put(org.id, "orgcfg", { enabled: true }, A.id))).code).toBe(
      "plugin.config_invalid",
    );
    await svc.put(org.id, "orgcfg", { enabled: false }, A.id);
    expect((await svc.list(org.id)).find((v) => v.plugin === "orgcfg")?.enabled).toBe(false);
  });

  it("插件升级后已存配置不合 schema：get 抛错含插件名、组织 ID 与路径，不含值", async () => {
    await svc.put(org.id, "orgcfg", { config: full }, A.id);
    await db
      .updateTable("plugin_org_configs")
      .set({ config: JSON.stringify({ appId: 98765, webhook: { path: "/h" } }) })
      .where("org_id", "=", org.id)
      .execute();
    const err = await svc.get(org.id, "orgcfg").then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("orgcfg");
    expect(err?.message).toContain(org.id);
    expect(err?.message).toContain("appId");
    expect(err?.message).not.toContain("98765");
    expect(err?.message).not.toContain(SECRET);
  });

  it("发起人角色在事务内实时重读：member 或非成员 → forbidden；组织不存在 → org.not_found", async () => {
    const m = await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    await members.add(org.id, m.id, "member", A.id);
    expect((await codeOf(svc.put(org.id, "orgcfg", { config: full }, m.id))).code).toBe(
      "forbidden",
    );
    expect((await codeOf(svc.put(org.id, "orgcfg", { config: full }, B.id))).code).toBe(
      "forbidden",
    );
    expect(
      (await codeOf(svc.put("00000000-0000-0000-0000-000000000000", "orgcfg", {}, A.id))).code,
    ).toBe("org.not_found");
  });

  it("审计 org.plugin_config.updated，detail 只含 enabled 与 changedPaths", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true, config: full }, A.id);
    await svc.put(
      org.id,
      "orgcfg",
      { config: { appId: "app-1", appSecret: "new-secret-xyz" } },
      A.id,
    );
    const rows = await db
      .selectFrom("audit_events")
      .select(["action", "target", "actor_account_id", "detail"])
      .where("action", "=", "org.plugin_config.updated")
      .orderBy("id")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ target: "orgcfg", actor_account_id: A.id });
    expect(rows[0]?.detail).toEqual({
      enabled: true,
      changedPaths: ["appId", "appSecret", "webhook.token", "webhook.path"],
    });
    expect(rows[1]?.detail).toEqual({
      enabled: true,
      changedPaths: ["appSecret", "webhook.path"],
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("new-secret-xyz");
    expect(text).not.toContain(TOKEN);
  });
});
