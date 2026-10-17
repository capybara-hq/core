import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, type PluginManifest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createPluginContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { PluginHost } from "../../src/plugins/host.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: PluginHost[] = [];

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const host = (cfg: Record<string, unknown> = {}, opts?: { resolveFrom?: string }) => {
  const h = new PluginHost(deps, cfg, opts);
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

  it("setup 抛错：带插件名", async () => {
    await expect(host().load([fx("throws")])).rejects.toThrow(/thrower.*boom/);
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
      { onSecrets: (v) => real.addSecrets(v) },
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
    const ctx = createPluginContext(deps, mf(), {});
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
    const r = await PluginHost.migrateOnly([fx("fixture"), fx("throws")], { dbUrl: deps.dbUrl });
    expect(r.map((x) => x.plugin)).toEqual(["fixture"]);
    expect(r[0]?.schema).toBe("plugin_fixture");
  });

  it("依赖解析失败同样报错（不迁移）", async () => {
    await expect(
      PluginHost.migrateOnly([fx("fixture"), fx("fixture")], { dbUrl: deps.dbUrl }),
    ).rejects.toThrow(/more than once/);
  });
});
