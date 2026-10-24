import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;

const PW = "correct horse battery";
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
      log: { level: "error" },
      extensions: [
        fx("cap-chan-a"),
        fx("cap-chan-b"),
        fx("cap-consumer"),
        fx("orgcfg"),
        fx("cap-chan-v2"),
        fx("cap-consumer-v2"),
      ],
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  redis = new Redis(rd.url);
  accounts = new AccountsService((await import("../../src/db/kernel-schema.js")).kernelDb(raw));
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
  await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

type Err = { error?: { code?: string; details?: unknown[] } };

async function setup() {
  const req = asUser(k.http, cookieJar());
  const login = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  const orgId = (res.json() as { org: { id: string } }).org.id;
  const put = (plugin: string, payload: Record<string, unknown>) =>
    req({ method: "PUT", url: `/api/v1/orgs/${orgId}/extensions/${plugin}`, payload });
  return { req, orgId, put };
}

describe("组织启用插件：依赖校验", () => {
  it("no provider for an orgScoped dependency -> 409 extension.dependency_missing listing the extension points", async () => {
    const { put } = await setup();
    const res = await put("cap-consumer", { enabled: true });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("extension.dependency_missing");
    expect(body.error?.details).toEqual([{ extensionPoint: "channel@1" }]);
  });

  it("提供方在该组织启用后，依赖方可启用（别的组织的启用不算）", async () => {
    const { put, orgId, req } = await setup();
    expect((await put("cap-chan-a", { enabled: true })).statusCode).toBe(200);
    expect((await put("cap-consumer", { enabled: true })).statusCode).toBe(200);
    // 另一个组织没有启用任何提供方：启用提供方只对当前组织有效
    const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Beta" } });
    const org2 = (res.json() as { org: { id: string } }).org.id;
    const r2 = await req({
      method: "PUT",
      url: `/api/v1/orgs/${org2}/extensions/cap-consumer`,
      payload: { enabled: true },
    });
    expect(r2.statusCode).toBe(409);
    expect(orgId).not.toBe(org2);
  });

  it("disabling the only provider something depends on -> 409 extension.has_dependents; force lets it through", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    await put("cap-consumer", { enabled: true });
    const res = await put("cap-chan-a", { enabled: false });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("extension.has_dependents");
    expect(body.error?.details).toEqual([{ plugin: "cap-consumer", extensionPoint: "channel@1" }]);
    const forced = await put("cap-chan-a", { enabled: false, force: true });
    expect(forced.statusCode).toBe(200);
  });

  it("还有别的已启用提供方时，停用其一不受阻", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    await put("cap-chan-b", { enabled: true });
    await put("cap-consumer", { enabled: true });
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    expect((await put("cap-chan-b", { enabled: false })).statusCode).toBe(409);
  });

  it("没有依赖方时停用不受阻；非布尔 force 被拒", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    expect((await put("cap-chan-a", { force: "yes" })).statusCode).toBe(400);
  });
});

describe("依赖按主版本匹配与未加载提供方", () => {
  it("requires channel@2 不能由 channel@1 的提供方满足，停用只看同主版本的依赖方", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    const r = await put("cap-consumer-v2", { enabled: true });
    expect(r.statusCode).toBe(409);
    expect((r.json() as Err).error?.details).toEqual([{ extensionPoint: "channel@2" }]);
    expect((await put("cap-chan-v2", { enabled: true })).statusCode).toBe(200);
    expect((await put("cap-consumer-v2", { enabled: true })).statusCode).toBe(200);
    // 停用 channel@1 提供方不受 channel@2 依赖方影响
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    const d = await put("cap-chan-v2", { enabled: false });
    expect(d.statusCode).toBe(409);
    expect((d.json() as Err).error?.details).toEqual([
      { plugin: "cap-consumer-v2", extensionPoint: "channel@2" },
    ]);
  });

  it("未加载（如待批准）的提供方即使留有已启用记录也算缺席", async () => {
    const { put, orgId } = await setup();
    await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
      VALUES ('pending-chan', ${orgId}, true)`.execute(raw);
    const res = await put("cap-consumer", { enabled: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Err).error?.code).toBe("extension.dependency_missing");
  });
});

describe("GET 插件列表：权限清单与配置 schema", () => {
  it("permissions 按类别分组并标敏感项；orgConfigSchema 的密钥带 x-secret", async () => {
    const { req, orgId } = await setup();
    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(res.statusCode).toBe(200);
    const { extensions: plugins } = res.json() as {
      extensions: {
        plugin: string;
        permissions: { category: string; sensitive: boolean; items: string[] }[];
        orgConfigSchema: { properties?: Record<string, Record<string, unknown>> } | null;
      }[];
    };
    const consumer = plugins.find((p) => p.plugin === "cap-consumer");
    expect(consumer?.permissions).toEqual(
      expect.arrayContaining([
        {
          category: "provides",
          sensitive: false,
          items: ["counter@1"],
          entries: [{ value: "counter@1", sensitive: false }],
        },
        {
          category: "requires",
          sensitive: false,
          items: ["channel@1"],
          entries: [{ value: "channel@1", sensitive: false }],
        },
        {
          category: "optional",
          sensitive: false,
          items: ["directory@1"],
          entries: [{ value: "directory@1", sensitive: false }],
        },
      ]),
    );
    expect(consumer?.orgConfigSchema).toBeNull();
    const org = plugins.find((p) => p.plugin === "orgcfg");
    const secrets = org?.permissions.find((g) => g.category === "secrets");
    expect(secrets).toMatchObject({
      category: "secrets",
      sensitive: true,
      items: expect.arrayContaining(["appSecret"]),
      entries: expect.arrayContaining([{ value: "appSecret", sensitive: true, reason: "secrets" }]),
    });
    expect(org?.orgConfigSchema?.properties?.appSecret?.["x-secret"]).toBe(true);
    expect(org?.orgConfigSchema?.properties?.appId).not.toHaveProperty("x-secret");
  });
});
