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
      plugins: [fx("cap-chan-a"), fx("cap-chan-b"), fx("cap-consumer"), fx("orgcfg")],
      pluginPermissions: { autoApprove: true },
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
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
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
    req({ method: "PUT", url: `/api/v1/orgs/${orgId}/plugins/${plugin}`, payload });
  return { req, orgId, put };
}

describe("组织启用插件：依赖校验", () => {
  it("缺少 orgScoped 依赖的提供方 → 409 plugin.dependency_missing 并列出能力", async () => {
    const { put } = await setup();
    const res = await put("cap-consumer", { enabled: true });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("plugin.dependency_missing");
    expect(body.error?.details).toEqual([{ capability: "channel@1" }]);
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
      url: `/api/v1/orgs/${org2}/plugins/cap-consumer`,
      payload: { enabled: true },
    });
    expect(r2.statusCode).toBe(409);
    expect(orgId).not.toBe(org2);
  });

  it("停用被依赖的唯一提供方 → 409 plugin.has_dependents；force 放行", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    await put("cap-consumer", { enabled: true });
    const res = await put("cap-chan-a", { enabled: false });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("plugin.has_dependents");
    expect(body.error?.details).toEqual([{ plugin: "cap-consumer", capability: "channel@1" }]);
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

describe("GET 插件列表：权限清单与配置 schema", () => {
  it("permissions 按类别分组并标敏感项；orgConfigSchema 的密钥带 x-secret", async () => {
    const { req, orgId } = await setup();
    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/plugins` });
    expect(res.statusCode).toBe(200);
    const { plugins } = res.json() as {
      plugins: {
        plugin: string;
        permissions: { category: string; sensitive: boolean; items: string[] }[];
        orgConfigSchema: { properties?: Record<string, Record<string, unknown>> } | null;
      }[];
    };
    const consumer = plugins.find((p) => p.plugin === "cap-consumer");
    expect(consumer?.permissions).toEqual(
      expect.arrayContaining([
        { category: "provides", sensitive: false, items: ["counter@1"] },
        { category: "requires", sensitive: false, items: ["channel@1"] },
        { category: "optional", sensitive: false, items: ["directory@1"] },
      ]),
    );
    expect(consumer?.orgConfigSchema).toBeNull();
    const org = plugins.find((p) => p.plugin === "orgcfg");
    const secrets = org?.permissions.find((g) => g.category === "secrets");
    expect(secrets).toEqual({
      category: "secrets",
      sensitive: true,
      items: expect.arrayContaining(["appSecret"]),
    });
    expect(org?.orgConfigSchema?.properties?.appSecret?.["x-secret"]).toBe(true);
    expect(org?.orgConfigSchema?.properties?.appId).not.toHaveProperty("x-secret");
  });
});
