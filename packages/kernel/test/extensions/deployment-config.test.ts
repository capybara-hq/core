import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadConfigWithSources, resolveConfig } from "../../src/config/load.js";
import { extensionConfigSources } from "../../src/config/sources.js";
import { createKeyring, createSecrets } from "../../src/ctx/secrets.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  DEPLOYMENT_SECRETS_ORG,
  ExtensionDeploymentConfigService,
} from "../../src/extensions/deployment-config.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { deploycfgProbe } from "../fixtures/plugins/deploycfg/index.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, type Req, session, waitFor } from "../helpers/runs.js";

const DEPLOYCFG = fileURLToPath(new URL("../fixtures/plugins/deploycfg/index.ts", import.meta.url));
const BADCONFIG = fileURLToPath(new URL("../fixtures/plugins/badconfig/index.ts", import.meta.url));
const TOKEN = "tok-Zq8vR3secret-value";
const TOKEN2 = "tok-second-Wm4kP9value";

interface Field {
  path: string;
  secret: boolean;
  hot: boolean;
  source: string;
  readonly: boolean;
  value?: unknown;
  set?: boolean;
}
interface ConfigView {
  plugin: string;
  version: string;
  configurable: boolean;
  fields: Field[];
  schema: Record<string, unknown> | null;
  valid: boolean;
  validated: boolean;
  issues: { path: string; message: string }[];
}

describe("配置来源标注（extensionConfigSources / loadConfigWithSources）", () => {
  it("文件里的叶子标 file、Nacos 来源标 nacos；环境变量（逐字段与整段 JSON）覆盖为 env", () => {
    const raw = {
      extensionConfig: {
        a: { x: 1, nested: { y: "f" }, list: [1, 2] },
        b: { z: true },
      },
    };
    const env = {
      CAPYBARA_EXTENSION_CONFIG__A__NESTED__Y: "e",
      CAPYBARA_EXTENSION_CONFIG__C_D__W: "3",
    };
    expect(extensionConfigSources(raw, env, "file")).toEqual({
      a: { x: "file", "nested.y": "env", list: "file" },
      b: { z: "file" },
      "c-d": { w: "env" },
    });
    expect(extensionConfigSources(raw, {}, "nacos").a).toEqual({
      x: "nacos",
      "nested.y": "nacos",
      list: "nacos",
    });
    expect(
      extensionConfigSources(
        {},
        { CAPYBARA_EXTENSION_CONFIG: JSON.stringify({ q: { k: 1 } }) },
        "file",
      ),
    ).toEqual({ q: { k: "env" } });
  });

  it("loadConfigWithSources reads the file, merges env vars and reports the extension config sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-cfg-src-"));
    try {
      const file = join(dir, "c.yaml");
      await writeFile(
        file,
        stringify({
          db: { url: "postgres://x/y" },
          redis: { url: "redis://x" },
          masterKey: Buffer.alloc(32, 1).toString("base64"),
          extensionConfig: { p: { a: 1, b: 2 } },
        }),
      );
      const { config, extensionConfigSources } = await loadConfigWithSources({
        CAPYBARA_CONFIG_FILE: file,
        CAPYBARA_EXTENSION_CONFIG__P__B: "5",
      });
      expect(config.extensionConfig).toEqual({ p: { a: 1, b: 5 } });
      expect(extensionConfigSources).toEqual({ p: { a: "file", b: "env" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("部署级插件配置入 PG（审查重点 5）", { timeout: 120_000 }, () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let db: KernelDb;
  let destroyDb: () => Promise<void>;
  let k: Kernel | undefined;
  let admin: Req;
  let member: Req;
  const lines: string[] = [];

  /** 文件来源（region）与环境变量（poolSize）各占一个字段；endpoint 必填但没配。 */
  async function boot(fileCfg: Record<string, unknown>): Promise<Kernel> {
    const env = {
      CAPYBARA_EXTENSION_CONFIG__DEPLOYCFG__POOL_SIZE: "3",
      CAPYBARA_EXTENSION_CONFIG__DEPLOYCFG__HEADERS__X: "v1",
    };
    const raw = {
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, DEPLOYCFG],
      extensionPermissions: { autoApprove: true },
      extensionConfig: { deploycfg: fileCfg },
    };
    const kernel = await createKernel(resolveConfig(raw, env), {
      env,
      logger: createLogger("info", { write: (l) => lines.push(l) }),
      extensionConfigSources: extensionConfigSources(raw, env, "file"),
      // 内置插件（C14）同样可以在 PG 里配：badconfig 的必填字段 port 没配，待配置
      builtinExtensions: [BADCONFIG],
    });
    await kernel.start();
    return kernel;
  }

  const getView = async (req: Req = admin) => {
    const res = await req({ method: "GET", url: "/api/v1/admin/extensions/deploycfg/config" });
    expect(res.statusCode, res.body).toBe(200);
    // 只给插件配置视图：内核配置（masterKey、数据库 / Redis 地址）绝不出现在响应里
    expect(res.body).not.toContain("masterKey");
    expect(res.body).not.toContain(Buffer.alloc(32, 7).toString("base64"));
    expect(res.body).not.toContain(pgc.url);
    expect(res.body).not.toContain(rd.url);
    expect(Object.keys(res.json()).sort()).toEqual(
      [
        "configurable",
        "fields",
        "issues",
        "plugin",
        "schema",
        "valid",
        "validated",
        "version",
      ].sort(),
    );
    return res.json() as ConfigView;
  };
  const put = (values: Record<string, unknown>, req: Req = admin) =>
    req({ method: "PUT", url: "/api/v1/admin/extensions/deploycfg/config", payload: { values } });
  const field = (v: ConfigView, path: string) => v.fields.find((f) => f.path === path) as Field;
  const live = () => deploycfgProbe().ctx?.config as Record<string, unknown> | undefined;

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const raw = createDb(pgc.url, 3);
    db = kernelDb(raw);
    destroyDb = () => raw.destroy();
    await truncateTables(
      db,
      "capybara.extension_deployment_configs, capybara.secrets, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
    );
    const accounts = new AccountsService(db);
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    k = await boot({ region: "eu-file", mode: "auto" });
    admin = await session(k, "root");
    member = await session(k, "mem");
  }, 240_000);

  afterAll(async () => {
    await k?.stop();
    await destroyDb?.();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  it("必填字段缺失：内核照常启动，插件待配置（pending / config），没有 setup", async () => {
    expect(deploycfgProbe().setups).toBe(0);
    const res = await admin({ method: "GET", url: "/api/v1/admin/extensions/deploycfg" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "pending_config", configValid: false });
    const rows = await db
      .selectFrom("extension_replica_status")
      .selectAll()
      .where("plugin", "=", "deploycfg")
      .execute();
    expect(rows.map((r) => [r.state, r.reason])).toEqual([["pending", "config"]]);
  });

  it("非企业管理员 GET / PUT 403", async () => {
    expect(
      (await member({ method: "GET", url: "/api/v1/admin/extensions/deploycfg/config" }))
        .statusCode,
    ).toBe(403);
    expect((await put({ endpoint: "x" }, member)).statusCode).toBe(403);
    expect(
      (await admin({ method: "GET", url: "/api/v1/admin/extensions/nope/config" })).statusCode,
    ).toBe(404);
    // 守卫之后被撤销的企业管理员：事务里锁内复核（直接调服务，绕过守卫）
    const mem = await db
      .selectFrom("accounts")
      .select("id")
      .where("display_name", "=", "M")
      .executeTakeFirstOrThrow();
    await expect(
      k?.extensionDeploymentConfigs.put("deploycfg", { endpoint: "https://x" }, mem.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.selectFrom("extension_deployment_configs").selectAll().execute()).toEqual([]);
  });

  it("来源标注：文件 / 环境变量只读并显示来源，其余为默认值或未设置", async () => {
    const v = await getView();
    expect(v).toMatchObject({
      plugin: "deploycfg",
      version: "0.1.0",
      configurable: true,
      valid: false,
    });
    expect(v.issues.map((i) => i.path)).toEqual(["endpoint"]);
    expect(v.schema).toMatchObject({ type: "object" });
    expect(field(v, "region")).toMatchObject({ source: "file", readonly: true, value: "eu-file" });
    expect(field(v, "poolSize")).toMatchObject({ source: "env", readonly: true, value: 3 });
    expect(field(v, "greeting")).toMatchObject({
      source: "default",
      readonly: false,
      hot: true,
      value: "hi",
    });
    expect(field(v, "limits.burst")).toMatchObject({ source: "default", hot: true, value: 5 });
    expect(field(v, "endpoint")).toMatchObject({ source: "unset", readonly: false, hot: false });
    expect(field(v, "endpoint").value).toBeUndefined();
    expect(field(v, "token")).toEqual({
      path: "token",
      secret: true,
      hot: false,
      source: "unset",
      readonly: false,
      set: false,
    });
  });

  it("PUT of a read-only field (file / env) -> 409 extension.config_readonly; unknown field or invalid value -> 400 without echoing values", async () => {
    for (const values of [
      { region: "us" },
      { poolSize: 9 },
      { endpoint: "https://a", region: null },
    ]) {
      const res = await put(values);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("extension.config_readonly");
    }
    const unknown = await put({ nope: 1 });
    expect(unknown.statusCode, unknown.body).toBe(400);
    expect(unknown.json().error.code).toBe("extension.config_invalid");
    const bad = await put({ endpoint: "https://a", "limits.burst": "not-a-number-xyz" });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("extension.config_invalid");
    expect(bad.body).not.toContain("not-a-number-xyz");
    expect(bad.json().error.details).toEqual([
      { path: "limits.burst", message: expect.any(String) },
    ]);
    // 什么都没写
    expect(await db.selectFrom("extension_deployment_configs").selectAll().execute()).toEqual([]);
  });

  it("补上必填字段后不重启即加载；密钥只存 secrets（_deployment），响应、审计与日志里都没有值", async () => {
    const res = await put({ endpoint: "https://one.example", token: TOKEN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    const v = res.json() as ConfigView;
    expect(v.valid).toBe(true);
    expect(field(v, "endpoint")).toMatchObject({
      source: "db",
      readonly: false,
      value: "https://one.example",
    });
    expect(field(v, "token")).toEqual({
      path: "token",
      secret: true,
      hot: false,
      source: "db",
      readonly: false,
      set: true,
    });

    await waitFor(async () => deploycfgProbe().setups === 1, 10_000, "deploycfg loaded");
    expect(live()).toMatchObject({
      endpoint: "https://one.example",
      region: "eu-file",
      poolSize: 3,
      token: TOKEN,
    });
    await waitFor(async () => {
      const r = await admin({ method: "GET", url: "/api/v1/admin/extensions/deploycfg" });
      return r.json().status === "enabled";
    });

    const row = await db
      .selectFrom("extension_deployment_configs")
      .selectAll()
      .where("plugin", "=", "deploycfg")
      .executeTakeFirstOrThrow();
    expect(row.config).toEqual({ endpoint: "https://one.example" });
    const secretRows = await db
      .selectFrom("secrets")
      .select(["namespace", "org_id", "key"])
      .execute();
    expect(secretRows).toEqual([
      {
        namespace: "kernel",
        org_id: DEPLOYMENT_SECRETS_ORG,
        key: "plugin-deployment-config:deploycfg:token",
      },
    ]);
    expect(DEPLOYMENT_SECRETS_ORG).toBe("_deployment");
    const audits = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "extension.deployment_config_updated")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: "deploycfg" });
    expect(audits[0]?.detail).toEqual({ changedPaths: ["endpoint", "token"] });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);

    // GET 同样不回显；插件 setup 时把密钥写进日志：日志已打码
    expect(JSON.stringify(await getView())).not.toContain(TOKEN);
    expect(lines.some((l) => l.includes("deploycfg setup"))).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("hot 字段：就地替换，ctx.config 读到新值，不重新 setup", async () => {
    const before = deploycfgProbe().setups;
    const ctx = deploycfgProbe().ctx;
    const res = await put({ greeting: "hello", "limits.burst": 9 });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor(async () => live()?.greeting === "hello", 10_000, "hot greeting");
    expect(live()).toMatchObject({ limits: { burst: 9 }, endpoint: "https://one.example" });
    expect(deploycfgProbe().setups).toBe(before);
    expect(deploycfgProbe().ctx).toBe(ctx);
  });

  it("非 hot 字段：重新加载实例（setup 次数 +1），新实例读到新值；密钥缺省保留、null 清除", async () => {
    const before = deploycfgProbe().setups;
    const res = await put({ endpoint: "https://two.example" });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor(async () => deploycfgProbe().setups === before + 1, 10_000, "reload");
    expect(live()).toMatchObject({
      endpoint: "https://two.example",
      greeting: "hello",
      token: TOKEN,
    });

    const cleared = await put({ token: null, greeting: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const v = cleared.json() as ConfigView;
    expect(field(v, "token")).toMatchObject({ source: "unset", set: false });
    expect(field(v, "greeting")).toMatchObject({ source: "default", value: "hi" });
    await waitFor(async () => live()?.token === undefined, 10_000, "token cleared");
    expect(await db.selectFrom("secrets").selectAll().execute()).toEqual([]);

    const again = await put({ token: TOKEN2 });
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain(TOKEN2);
    await waitFor(async () => live()?.token === TOKEN2, 10_000, "token set again");
    expect(lines.join("\n")).not.toContain(TOKEN2);
  });

  it("非 hot 改动重新加载失败：旧实例与旧加载参数保留；PG 改回后 unchanged，reload 不用失败的配置", async () => {
    const ctx = deploycfgProbe().ctx;
    const before = deploycfgProbe().setups;
    const res = await put({ failSetup: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(deploycfgProbe().ctx).toBe(ctx);
    expect(live()?.failSetup).toBe(false);
    const back = await put({ failSetup: null });
    expect(back.statusCode, back.body).toBe(200);
    expect(await k?.host.applyDeploymentConfig("deploycfg")).toBe("unchanged");
    // 加载参数若还是失败的那份，这里会抛 setup failed
    await k?.host.reload("deploycfg");
    expect(deploycfgProbe().setups).toBe(before + 1);
    expect(live()?.failSetup).toBe(false);
  });

  it("只读字段等于默认值仍标来源；数组 / record 字段：环境变量给了 record 的键 → 整个字段只读，数组可在后台改", async () => {
    let v = await getView();
    expect(field(v, "mode")).toMatchObject({ source: "file", readonly: true, value: "auto" });
    expect(field(v, "headers")).toMatchObject({
      source: "env",
      readonly: true,
      value: { x: "v1" },
    });
    expect(field(v, "tags")).toMatchObject({ source: "default", readonly: false, value: [] });
    expect((await put({ mode: "auto" })).statusCode).toBe(409);
    expect((await put({ headers: { y: "2" } })).statusCode).toBe(409);
    const res = await put({ tags: ["a", "b"] });
    expect(res.statusCode, res.body).toBe(200);
    v = res.json() as ConfigView;
    expect(field(v, "tags")).toMatchObject({ source: "db", value: ["a", "b"] });
    await waitFor(async () => (live()?.tags as string[] | undefined)?.length === 2, 10_000, "tags");
    expect(live()?.headers).toEqual({ x: "v1" });
  });

  it("本副本拿不到模块（静态清单）：validated false、schema null", async () => {
    const svc = new ExtensionDeploymentConfigService({
      db,
      keyring: createKeyring(Buffer.alloc(32, 7), []),
      fileConfig: () => ({}),
      sources: {},
      schemaOf: async () => ({
        version: "1.0.0",
        fields: [{ path: "a", secret: false, hot: false }],
      }),
      log: { warn() {}, error() {} },
    });
    expect(await svc.view("static-only")).toMatchObject({
      validated: false,
      valid: true,
      schema: null,
    });
    expect((await getView()).validated).toBe(true);
  });

  it("secrets 里留着当前 schema 已不是密钥（或已删掉）的字段：不并入生效配置与视图", async () => {
    const { z } = await import("zod");
    const { secret } = await import("@capybara-hq/plugin-sdk");
    const keyring = createKeyring(Buffer.alloc(32, 7), []);
    // 旧版本里 a 是密钥、gone 也是；新版本 a 不再是密钥、gone 删掉了，b 仍是密钥
    const secrets = createSecrets(db, keyring, "kernel");
    for (const [path, v] of [
      ["a", "old-secret-a-value"],
      ["gone", "old-secret-gone"],
      ["b", "still-secret-b"],
    ] as const) {
      await secrets.set(
        DEPLOYMENT_SECRETS_ORG,
        `plugin-deployment-config:stale:${path}`,
        JSON.stringify(v),
      );
    }
    const schema = z.object({ a: z.string().optional(), b: secret(z.string()).optional() });
    const svc = new ExtensionDeploymentConfigService({
      db,
      keyring,
      fileConfig: () => ({}),
      sources: {},
      schemaOf: async () => ({
        version: "2.0.0",
        schema,
        fields: [
          { path: "a", secret: false, hot: false },
          { path: "b", secret: true, hot: false },
        ],
      }),
      log: { warn() {}, error() {} },
    });
    expect(await svc.effective("stale", undefined, schema)).toEqual({ b: "still-secret-b" });
    const v = await svc.view("stale");
    expect(JSON.stringify(v)).not.toContain("old-secret");
    expect(v.fields.find((f) => f.path === "b")).toMatchObject({ set: true });
  });

  it("内置插件同样可以在 PG 里配：待配置 → 保存后不重启即加载", async () => {
    const before = await admin({ method: "GET", url: "/api/v1/admin/extensions/badconfig" });
    expect(before.json()).toMatchObject({ source: "builtin", status: "pending_config" });
    expect(k?.host.current("badconfig")).toBeUndefined();
    const res = await admin({
      method: "PUT",
      url: "/api/v1/admin/extensions/badconfig/config",
      payload: { values: { port: 8080 } },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor(async () => k?.host.current("badconfig"), 10_000, "builtin loaded");
    expect(k?.host.current("badconfig")?.config).toEqual({ port: 8080 });
    const after = await admin({ method: "GET", url: "/api/v1/admin/extensions/badconfig" });
    expect(after.json()).toMatchObject({ status: "enabled", configValid: true });
  });

  it("丢了 plugin-deployment-config 消息：周期 reconcile 兜底重读（hot 字段就地替换）", async () => {
    const before = deploycfgProbe().setups;
    // 直接改 PG、不发布 plugin-deployment-config
    await db
      .updateTable("extension_deployment_configs")
      .set({
        config: JSON.stringify({
          endpoint: "https://two.example",
          tags: ["a", "b"],
          greeting: "from-pg",
        }),
      })
      .where("plugin", "=", "deploycfg")
      .execute();
    await k?.bus.publish("plugins.reconcile", {});
    await waitFor(async () => live()?.greeting === "from-pg", 10_000, "periodic picks it up");
    expect(deploycfgProbe().setups).toBe(before);
  });

  it("文件后来加了 PG 里已有的字段：以文件为准并显示为只读；PUT 该字段 409", async () => {
    await k?.stop();
    k = undefined;
    k = await boot({ region: "eu-file", mode: "auto", endpoint: "https://file.example" });
    admin = await session(k, "root");
    const v = await getView();
    expect(field(v, "endpoint")).toMatchObject({
      source: "file",
      readonly: true,
      value: "https://file.example",
    });
    // PG 里那份仍在，只是被文件盖住
    const row = await db
      .selectFrom("extension_deployment_configs")
      .select("config")
      .where("plugin", "=", "deploycfg")
      .executeTakeFirstOrThrow();
    expect(row.config).toMatchObject({ endpoint: "https://two.example" });
    await waitFor(async () => live()?.endpoint === "https://file.example", 10_000, "file wins");
    expect(live()?.token).toBe(TOKEN2);
    const res = await put({ endpoint: "https://three.example" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("extension.config_readonly");
  });
});
