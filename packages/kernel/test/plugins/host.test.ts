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
import { PluginHost } from "../../src/plugins/host.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: PluginHost[] = [];

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const host = (cfg: Record<string, unknown> = {}) => {
  const h = new PluginHost(deps, cfg);
  hosts.push(h);
  return h;
};
const log = { info() {}, warn() {}, error() {} };

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

describe("createPluginContext 规则", () => {
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
