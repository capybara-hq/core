import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { Credentials } from "../../src/tools/credentials.js";
import { canonicalJson, specHash, ToolRegistry } from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { asUser, cookieJar } from "../helpers/http.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let registry: ToolRegistry;
let req: ReturnType<typeof asUser>;
let orgId: string;

const PW = "correct horse battery";
const log = createLogger("error", { write: () => {} });

const askUser = {
  spec: {
    name: "ask_user",
    description: "Ask the user a question.",
    inputSchema: { type: "object" },
  },
  defaultPolicy: "allow" as const,
  run: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      plugins: [MEM_CONNECTOR],
    }),
    { env: {}, logger: log },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  registry = new ToolRegistry({
    db,
    host: k.host,
    credentials: new Credentials(db, createKeyring(Buffer.alloc(32, 7), []), log),
    log,
    builtins: [askUser],
  });
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
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  memState().servers = {
    open: {
      tools: [
        {
          name: "read",
          description: "Read.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "write", description: "Write.", inputSchema: { type: "object" } },
        { name: "drop", description: "Drop.", inputSchema: { type: "object" } },
      ],
    },
  };
  req = asUser(k.http, cookieJar());
  expect(
    (
      await req({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { login: "owner", password: PW },
      })
    ).statusCode,
  ).toBe(200);
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
});

async function installApp(slug: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/apps`,
    payload: {
      name: slug,
      slug,
      connector: "mem",
      endpoint: { server: "open" },
      auth: { type: "none" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { app: { id: string } }).app.id;
}

async function enablePlugin(plugin: string, enabled: boolean): Promise<void> {
  const res = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe("ToolRegistry", () => {
  it("canonicalJson 键排序；specHash 为 16 位十六进制且与键顺序无关", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    const h = specHash({ name: "x", description: "d", inputSchema: { type: "object" } });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(specHash({ inputSchema: { type: "object" }, description: "d", name: "x" })).toBe(h);
  });

  it("connector(kind) 按 kind 查找；未安装抛错", () => {
    expect(registry.connector("mem").kind).toBe("mem");
    expect(() => registry.connector("nope")).toThrow();
  });

  it("内置、插件、应用工具都能解析；插件工具须本组织启用该插件", async () => {
    const appId = await installApp("docs");
    const def = {
      tools: [
        { kind: "builtin" as const, name: "ask_user" },
        { kind: "plugin" as const, plugin: "mem-connector", name: "echo" },
        { kind: "plugin" as const, plugin: "mem-connector", name: "wipe" },
        { kind: "app" as const, appId, tools: "all" as const },
      ],
    };
    const before = await registry.forAgent(orgId, def);
    expect(before.tools.map((t) => t.key)).toEqual([
      "ask_user",
      "docs__drop",
      "docs__read",
      "docs__write",
    ]);
    expect(before.unavailable).toEqual([
      {
        ref: "mem-connector__echo",
        reason: "Plugin mem-connector is not enabled in this organization",
      },
      {
        ref: "mem-connector__wipe",
        reason: "Plugin mem-connector is not enabled in this organization",
      },
    ]);

    await enablePlugin("mem-connector", true);
    const after = await registry.forAgent(orgId, def);
    expect(after.unavailable).toEqual([]);
    const byKey = Object.fromEntries(after.tools.map((t) => [t.key, t]));
    expect(byKey.ask_user).toMatchObject({
      source: { kind: "builtin", name: "ask_user" },
      defaultPolicy: "allow",
    });
    expect(byKey["mem-connector__echo"]).toMatchObject({
      source: { kind: "plugin", plugin: "mem-connector", name: "echo" },
      defaultPolicy: "allow", // readOnlyHint
    });
    // 插件显式声明 defaultPolicy 优先于注解
    expect(byKey["mem-connector__wipe"]?.defaultPolicy).toBe("allow");
    expect(byKey.docs__read).toMatchObject({
      source: { kind: "app", appId, name: "read" },
      defaultPolicy: "allow",
    });
    expect(byKey.docs__write?.defaultPolicy).toBe("ask");
    expect(byKey.docs__read?.spec.description).toBe("Read.");
    expect(byKey.docs__read?.specHash).toBe(specHash(byKey.docs__read?.spec));
    expect(byKey.ask_user?.specHash).toBe(specHash(askUser.spec));
  });

  it("过滤停用 / 待复核 / 已删除，并给出原因", async () => {
    const appId = await installApp("docs");
    await db
      .updateTable("app_tools")
      .set({ status: "disabled" })
      .where("app_id", "=", appId)
      .where("name", "=", "write")
      .execute();
    await db
      .updateTable("app_tools")
      .set({ status: "pending_review" })
      .where("app_id", "=", appId)
      .where("name", "=", "drop")
      .execute();
    await db
      .updateTable("app_tools")
      .set({ default_policy: "deny" })
      .where("app_id", "=", appId)
      .where("name", "=", "read")
      .execute();

    // all：只取启用的工具，停用 / 待复核的不报
    const all = await registry.forAgent(orgId, {
      tools: [{ kind: "app", appId, tools: "all" }],
    });
    expect(all.tools.map((t) => t.key)).toEqual(["docs__read"]);
    expect(all.tools[0]?.defaultPolicy).toBe("deny");
    expect(all.unavailable).toEqual([]);

    // 点名：逐个报原因
    const named = await registry.forAgent(orgId, {
      tools: [
        { kind: "app", appId, tools: ["read", "write", "drop", "gone"] },
        { kind: "builtin", name: "nope" },
        { kind: "plugin", plugin: "not-loaded", name: "x" },
        { kind: "app", appId: "missing-app", tools: "all" },
      ],
    });
    expect(named.tools.map((t) => t.key)).toEqual(["docs__read"]);
    expect(named.unavailable).toEqual([
      { ref: "docs__write", reason: "Tool is disabled" },
      { ref: "docs__drop", reason: "Tool is pending review" },
      { ref: "docs__gone", reason: "Tool no longer exists in app docs" },
      { ref: "nope", reason: "Built-in tool does not exist" },
      { ref: "not-loaded__x", reason: "Plugin tool does not exist" },
      { ref: "app:missing-app", reason: "App does not exist" },
    ]);

    // 应用停用 → 整个应用不可用
    await db.updateTable("apps").set({ status: "disabled" }).where("id", "=", appId).execute();
    const disabled = await registry.forAgent(orgId, {
      tools: [{ kind: "app", appId, tools: "all" }],
    });
    expect(disabled.tools).toEqual([]);
    expect(disabled.unavailable).toEqual([{ ref: "docs__*", reason: "App docs is disabled" }]);

    // 应用删除
    const del = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/apps/${appId}` });
    expect(del.statusCode).toBe(204);
    const deleted = await registry.forAgent(orgId, {
      tools: [{ kind: "app", appId, tools: ["read"] }],
    });
    expect(deleted.unavailable).toEqual([{ ref: "docs__*", reason: "App docs was deleted" }]);

    // 别的组织的应用 id → 视为不存在
    const other = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Other" } });
    const otherId = (other.json() as { org: { id: string } }).org.id;
    const app2 = await installApp("docs2");
    const cross = await registry.forAgent(otherId, {
      tools: [{ kind: "app", appId: app2, tools: "all" }],
    });
    expect(cross.unavailable).toEqual([{ ref: `app:${app2}`, reason: "App does not exist" }]);
  });

  it("同一 key 只保留第一个，其余报重复", async () => {
    const appId = await installApp("docs");
    const r = await registry.forAgent(orgId, {
      tools: [
        { kind: "builtin", name: "ask_user" },
        { kind: "builtin", name: "ask_user" },
        { kind: "app", appId, tools: ["read"] },
        { kind: "app", appId, tools: "all" },
      ],
    });
    expect(r.tools.map((t) => t.key)).toEqual([
      "ask_user",
      "docs__read",
      "docs__drop",
      "docs__write",
    ]);
    expect(r.unavailable).toEqual([]);
  });
});
