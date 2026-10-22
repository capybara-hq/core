import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, type PluginManifest, secret } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createPluginContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { deploymentConfigHash, PluginHost } from "../../src/plugins/host.js";

// closefail 插件的 ctx.close() 失败（先真正关闭，避免泄漏连接），验证宿主记 warn
vi.mock("../../src/ctx/create-ctx.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/ctx/create-ctx.js")>();
  return {
    ...real,
    createPluginContext: (...args: Parameters<typeof real.createPluginContext>) => {
      const ctx = real.createPluginContext(...args);
      if (args[1].name !== "closefail") return ctx;
      // 不能展开 ctx：未声明的成员（如 secrets）是访问即抛错的 getter
      const close = ctx.close;
      ctx.close = async () => {
        await close();
        throw new Error("close boom");
      };
      return ctx;
    },
  };
});

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: PluginHost[] = [];

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const host = (cfg: Record<string, unknown> = {}, opts?: { resolveFrom?: string }) => {
  // 本文件只测加载机制：自动批准权限（闸门本身见 approvals.test.ts）
  const h = new PluginHost(deps, cfg, { autoApprove: true, ...opts });
  hosts.push(h);
  return h;
};
const logged: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
const warned: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
const log = {
  info: (msg: string, fields?: Record<string, unknown>) => logged.push({ msg, fields }),
  warn: (msg: string, fields?: Record<string, unknown>) => warned.push({ msg, fields }),
  error() {},
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // 宿主读写插件权限快照（内核表）
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    runWorkers: false,
    log,
  };
});
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await sub.close();
  redis.disconnect();
  await deps.db.destroy();
  await Promise.all([pg.stop(), rd.stop()]);
});

describe("PluginHost", () => {
  it("load：迁移、setup、get/list/routes", async () => {
    const h = host({ fixture: { greeting: "yo" } });
    await h.load([fx("fixture"), fx("fixture2")]);
    const impl = h.get<{ kind: string; config: unknown }>("counter@1", "fixture");
    expect(impl).toEqual({ kind: "fixture", config: { greeting: "yo" } });
    const r = await sql<{
      n: string;
    }>`select count(*)::text as n from plugin_fixture.items`.execute(deps.db);
    expect(r.rows[0]?.n).toBe("1");
    expect(
      h
        .list("counter")
        .map((x) => x.plugin)
        .sort(),
    ).toEqual(["fixture", "fixture-two"]);
    expect(h.routes().map((x) => `${x.method} ${x.path}`)).toEqual(["GET /plugins/fixture/hello"]);
  });

  it("list 带出插件版本与部署配置摘要（16 位十六进制，不含配置明文）", async () => {
    const a = host({ fixture: { greeting: "yo" } });
    await a.load([fx("fixture")]);
    const b = host({ fixture: { greeting: "hey" } });
    await b.load([fx("fixture")]);
    const [ea] = a.list("counter");
    const [eb] = b.list("counter");
    expect(ea?.version).toBe(a.manifests()[0]?.version);
    expect(ea?.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(ea?.configHash).not.toBe(eb?.configHash);
  });

  it("deploymentConfigHash：先遮蔽 secret 字段——只差密钥时摘要相同，非密钥变化才变化；与键顺序无关", () => {
    const schema = z.object({
      a: z.number(),
      b: z.object({ y: z.array(z.number()), x: secret(z.string()) }),
      keys: secret(z.record(z.string(), z.string())).default({}),
      opt: z.object({ tok: secret(z.string()).optional() }).optional(),
    });
    const base = { a: 1, b: { x: "s3cr3t", y: [1, 2] }, keys: { ep: "sk-1" } };
    const h1 = deploymentConfigHash(schema, base);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    // 键顺序无关
    expect(
      deploymentConfigHash(schema, { keys: { ep: "sk-1" }, b: { y: [1, 2], x: "s3cr3t" }, a: 1 }),
    ).toBe(h1);
    // 只差 secret（含 record 形态的密钥）：摘要相同，轮换密钥不改变缓存键
    expect(deploymentConfigHash(schema, { ...base, b: { x: "other", y: [1, 2] } })).toBe(h1);
    expect(deploymentConfigHash(schema, { ...base, keys: { ep: "sk-2" } })).toBe(h1);
    expect(deploymentConfigHash(schema, { ...base, opt: { tok: "t1" } })).toBe(
      deploymentConfigHash(schema, { ...base, opt: { tok: "t2" } }),
    );
    // 非 secret 变化：摘要变化
    expect(deploymentConfigHash(schema, { ...base, a: 2 })).not.toBe(h1);
    expect(deploymentConfigHash(schema, { ...base, b: { x: "s3cr3t", y: [1] } })).not.toBe(h1);
    // 不修改传入的配置
    expect(base.b.x).toBe("s3cr3t");
    // 没有部署配置 schema（无法得知哪些是密钥）：不按配置区分
    expect(deploymentConfigHash(undefined, { token: "a" })).toBe(
      deploymentConfigHash(undefined, { token: "b" }),
    );
  });

  it("list 的 configHash 不随 secret 字段变化", async () => {
    const a = host({ secretcfg: { token: "token-one-123" } });
    await a.load([fx("secretcfg")]);
    const b = host({ secretcfg: { token: "token-two-456" } });
    await b.load([fx("secretcfg")]);
    expect(a.manifests()[0]?.name).toBe("secretcfg");
    const ha = a.current("secretcfg")?.configHash;
    const hb = b.current("secretcfg")?.configHash;
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(ha).toBe(hb);
  });

  it("配置缺省时使用 schema 默认值", async () => {
    const h = host();
    await h.load([fx("fixture")]);
    expect(h.get<{ config: unknown }>("counter@1", "fixture").config).toEqual({ greeting: "hi" });
  });

  it("get：多选能力必须指定 provider；未知能力与未知 provider 报错", async () => {
    const h = host();
    await h.load([fx("fixture"), fx("fixture2")]);
    expect(() => h.get("counter@1")).toThrow(/multi/);
    expect(() => h.get("counter@1", "nobody")).toThrow(/nobody/);
    expect(() => h.get("channel@1")).toThrow(/channel@1/);
  });

  it("部署配置不合法：点名插件与字段", async () => {
    await expect(host({ badconfig: { port: "x" } }).load([fx("badconfig")])).rejects.toThrow(
      /badconfig.*port/,
    );
    await expect(host().load([fx("badconfig")])).rejects.toThrow(/badconfig.*port/);
  });

  it("secret 不在对象路径叶子上（discriminatedUnion 内）：加载失败，点名插件与路径", async () => {
    await expect(host().load([fx("secretunion")])).rejects.toThrow(
      /plugin secretunion: config\.org: secret\(\) at "auth<union#1>\.token"/,
    );
  });

  it("secret 不在对象路径叶子上（transform 之后）：加载失败，点名插件与路径", async () => {
    await expect(host().load([fx("secrettransform")])).rejects.toThrow(
      /plugin secrettransform: config\.deployment: secret\(\) at "upstream<pipe:in>\.key"/,
    );
  });

  it("secret 在对象路径叶子上（含 optional / prefault 包装）：正常加载", async () => {
    await expect(host().load([fx("orgcfg")])).resolves.toBeUndefined();
  });

  it("setup 抛错：带插件名", async () => {
    await expect(host().load([fx("throws")])).rejects.toThrow(/thrower.*boom/);
  });

  it("setup 失败后 ctx.close() 也失败：记 warn，仍抛 setup 错误", async () => {
    warned.length = 0;
    await expect(host().load([fx("closefail")])).rejects.toThrow(/closefail.*setup boom/);
    const w = warned.filter((x) => x.msg === "plugin context close failed");
    expect(w).toHaveLength(1);
    expect(w[0]?.fields?.plugin).toBe("closefail");
    expect((w[0]?.fields?.err as Error | undefined)?.message).toBe("close boom");
  });

  it("setup 后声明的 provides 未提供：报错并点名", async () => {
    await expect(host().load([fx("noprovide")])).rejects.toThrow(/noprovide.*counter@1/);
  });
});

describe("PluginHost 配置加固", () => {
  it("orphan pluginConfig warns", async () => {
    warned.length = 0;
    await host({ ghost: {} }).load([fx("fixture")]);
    const w = warned.filter((x) => x.msg.includes("not loaded"));
    expect(w).toHaveLength(1);
    expect(w[0]?.fields).toEqual({ keys: ["ghost"] });
  });

  it("plugin deployment secrets are redacted", async () => {
    const lines: string[] = [];
    const real = createLogger("info", { write: (l) => lines.push(l) });
    const h = new PluginHost(
      { ...deps, log: real },
      { secretcfg: { token: "s3cr3t-value" } },
      { onSecrets: (v) => real.addSecrets(v), autoApprove: true },
    );
    hosts.push(h);
    await h.load([fx("secretcfg")]);
    expect(lines.filter((l) => l.includes('"got"'))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("s3cr3t-value");
  });
});

describe("PluginHost 加载规则", () => {
  it("清单不合法：抛 PluginManifestError 并点名 specifier", async () => {
    await expect(host().load([fx("malformed")])).rejects.toThrow(/malformed.*Foo|Foo/);
    await expect(host().load([fx("malformed")])).rejects.toMatchObject({
      name: "PluginManifestError",
      message: expect.stringContaining("malformed"),
    });
  });

  it("按 resolveFrom 解析裸包名，迁移目录相对解析后的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-"));
    try {
      const pkg = join(root, "node_modules/@capybara-hq/plugin-tmp");
      await mkdir(join(pkg, "migrations"), { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@capybara-hq/plugin-tmp",
          version: "0.0.0",
          type: "module",
          exports: { ".": { default: "./index.js" } },
        }),
      );
      await writeFile(
        join(pkg, "migrations/0001_t.sql"),
        "create table if not exists tmp_t (id int);",
      );
      await writeFile(
        join(pkg, "index.js"),
        `export default { name: "plugin-tmp", version: "0.1.0", sdk: "^0.1.0", provides: [], migrations: "./migrations", setup() {} };`,
      );
      const h = host({}, { resolveFrom: root });
      await h.load(["@capybara-hq/plugin-tmp"]);
      const r = await sql<{
        x: string | null;
      }>`select to_regclass('plugin_plugin_tmp.tmp_t')::text as x`.execute(deps.db);
      expect(r.rows[0]?.x).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("裸包名找不到：错误点名 specifier", async () => {
    await expect(host().load(["@capybara-hq/does-not-exist"])).rejects.toThrow(/does-not-exist/);
  });

  it("load 只能调用一次", async () => {
    const h = host();
    await h.load([fx("fixture2")]);
    await expect(h.load([fx("noprovide")])).rejects.toThrow(/already loaded/);
  });

  it("host.close 后插件的 bus 订阅不再收到消息", async () => {
    const h = host();
    await h.load([fx("subscriber")]);
    const pub = (p: unknown) => redis.publish("cap:subscriber:t", JSON.stringify(p));
    await pub("one");
    for (let i = 0; i < 100 && (await redis.get("cap:subscriber:kv:got")) === null; i++) {
      await sleep(20);
    }
    expect(await redis.get("cap:subscriber:kv:got")).toBe('"one"');
    await h.close();
    await pub("two");
    await sleep(300);
    expect(await redis.get("cap:subscriber:kv:got")).toBe('"one"');
  });
});

describe("createPluginContext 规则", () => {
  it("ctx 关闭后 bus.subscribe 以明确错误拒绝，不留下订阅；关闭与订阅并发时订阅方自行退订", async () => {
    const manifest = definePlugin({
      name: "late-sub",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: [],
      setup() {},
    });
    const ctx = createPluginContext(deps, manifest, {});
    await ctx.close();
    await expect(ctx.bus.subscribe("t", () => {})).rejects.toThrow(
      /late-sub: ctx is closed; bus\.subscribe is not allowed after close/,
    );
    // 订阅进行中时关闭：订阅完成后立即退订并报错
    const ctx2 = createPluginContext(deps, manifest, {});
    const pending = ctx2.bus.subscribe("t2", () => {});
    const closing = ctx2.close();
    await expect(pending).rejects.toThrow(/ctx is closed/);
    await closing;
    const channels = (await redis.pubsub("CHANNELS", "*late-sub*")) as string[];
    expect(channels).toEqual([]);
  });

  it("ctx.log 附加 plugin 字段", async () => {
    const ctx = createPluginContext(
      deps,
      definePlugin({ name: "logger-x", version: "0.1.0", sdk: "^0.1.0", provides: [], setup() {} }),
      {},
    );
    ctx.log.info("hello", { a: 1 });
    ctx.log.info("bare");
    expect(logged.at(-2)?.fields).toEqual({ a: 1, plugin: "logger-x" });
    expect(logged.at(-1)?.fields).toEqual({ plugin: "logger-x" });
    await ctx.close();
  });

  const mf = (over: Partial<PluginManifest> = {}) =>
    definePlugin({
      name: "ctx-test",
      version: "0.1.0",
      sdk: "^0.1.0",
      provides: ["counter@1"],
      setup() {},
      ...over,
    });

  it("provide 未声明的能力", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    expect(() => ctx.provide("channel@1", {})).toThrow(/ctx-test.*channel@1/);
    await ctx.close();
  });

  it("重复 provide 同一能力", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    ctx.provide("counter@1", {});
    expect(() => ctx.provide("counter@1", {})).toThrow(/counter@1/);
    await ctx.close();
  });

  it("http.route：路径必须以 / 开头、拒绝重复、带前缀", async () => {
    const ctx = createPluginContext(
      deps,
      mf({
        permissions: {
          http: [
            { method: "GET", path: "/a" },
            { method: "POST", path: "/a" },
          ],
        },
      }),
      {},
    );
    const h = async () => new Response("ok");
    expect(() => ctx.http.route("GET", "x", h)).toThrow(/start with/);
    ctx.http.route("GET", "/a", h);
    ctx.http.route("POST", "/a", h);
    expect(() => ctx.http.route("GET", "/a", h)).toThrow(/duplicate/);
    expect(ctx.routes.map((r) => r.path)).toEqual(["/plugins/ctx-test/a", "/plugins/ctx-test/a"]);
    await ctx.close();
  });

  it("db 切到 plugin_<name>（- 换成 _）", async () => {
    const ctx = createPluginContext(deps, mf({ name: "my-plug" }), {});
    await sql`create schema if not exists plugin_my_plug`.execute(deps.db);
    await sql`create table if not exists plugin_my_plug.t (id int)`.execute(deps.db);
    await expect(ctx.db.selectFrom("t").selectAll().execute()).resolves.toEqual([]);
    await ctx.close();
  });
});

describe("PluginHost.migrateOnly", () => {
  it("只跑迁移、不调用 setup；返回每个有迁移的插件", async () => {
    const r = await PluginHost.migrateOnly([fx("fixture"), fx("throws")], {
      dbUrl: deps.dbUrl,
      autoApprove: true,
    });
    expect(r.map((x) => x.plugin)).toEqual(["fixture"]);
    expect(r[0]?.schema).toBe("plugin_fixture");
  });

  it("插件的 secret 不在对象路径叶子上：同样拒绝（不迁移）", async () => {
    await expect(
      PluginHost.migrateOnly([fx("fixture2"), fx("secretunion")], {
        dbUrl: deps.dbUrl,
        autoApprove: true,
      }),
    ).rejects.toThrow(/plugin secretunion: config\.org: secret\(\) at "auth<union#1>\.token"/);
  });

  it("依赖解析失败同样报错（不迁移）", async () => {
    await expect(
      PluginHost.migrateOnly([fx("fixture"), fx("fixture")], {
        dbUrl: deps.dbUrl,
        autoApprove: true,
      }),
    ).rejects.toThrow(/more than once/);
  });
});
