import { fileURLToPath } from "node:url";
import {
  definePlugin,
  type PluginManifest,
  PluginPermissionError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createPluginContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
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
    log: quiet,
  };
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.audit_events`.execute(deps.db);
  await redis.flushdb();
});

const mf = (over: Partial<PluginManifest> = {}) =>
  definePlugin({
    name: "perm-test",
    version: "0.1.0",
    sdk: "^0.1.0",
    provides: [],
    setup() {},
    ...over,
  });

const denials = async () =>
  kernelDb(deps.db)
    .selectFrom("audit_events")
    .select(["action", "target", "detail"])
    .where("action", "=", "plugin.permission_denied")
    .execute();

const spec = (name: string): ToolSpec => ({ name, description: "Probe.", inputSchema: {} });
const handler = async () => ({ content: [] });

describe("ctx 按权限清单构造", () => {
  it("未声明 secrets：访问抛 PluginPermissionError 并写审计（每个插件每项只记一次）", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    expect(() => ctx.secrets).toThrow(PluginPermissionError);
    expect(() => ctx.secrets.get("o", "k")).toThrow(/permissions\.secrets/);
    await ctx.close();
    const rows = await denials();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("perm-test");
    expect(rows[0]?.detail).toMatchObject({ item: "permissions.secrets" });
    // 另一个 ctx（如另一副本）再次越权同一项：仍只记一次
    const again = createPluginContext(deps, mf(), {});
    expect(() => again.secrets).toThrow(PluginPermissionError);
    await again.close();
    expect(await denials()).toHaveLength(1);
    // 去重键带 TTL
    const keys = await redis.keys("capk:*");
    expect(keys).toHaveLength(1);
    expect(await redis.ttl(keys[0] as string)).toBeGreaterThan(0);
  });

  it("声明了 secrets：可用", async () => {
    const ctx = createPluginContext(deps, mf({ permissions: { secrets: true } }), {});
    expect(typeof ctx.secrets.get).toBe("function");
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("http.route：只允许清单中声明的 method + path", async () => {
    const ctx = createPluginContext(
      deps,
      mf({ permissions: { http: [{ method: "GET", path: "/a" }] } }),
      {},
    );
    const h = async () => new Response("ok");
    ctx.http.route("GET", "/a", h);
    expect(() => ctx.http.route("POST", "/a", h)).toThrow(PluginPermissionError);
    expect(() => ctx.http.route("GET", "/b", h)).toThrow(/permissions\.http.*GET \/b/);
    expect(ctx.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /plugins/perm-test/a"]);
    await ctx.close();
    const items = (await denials()).map((r) => (r.detail as { item: string }).item).sort();
    expect(items).toEqual(["permissions.http GET /b", "permissions.http POST /a"]);
  });

  it("没有 permissions.http：任何路由都被拒绝", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    expect(() => ctx.http.route("GET", "/a", async () => new Response())).toThrow(
      PluginPermissionError,
    );
    await ctx.close();
  });

  it("tools.register：只允许清单中声明的工具名", async () => {
    const ctx = createPluginContext(deps, mf({ permissions: { tools: ["echo"] } }), {});
    ctx.tools.register(spec("echo"), handler);
    expect(() => ctx.tools.register(spec("other"), handler)).toThrow(PluginPermissionError);
    expect(() => ctx.tools.register(spec("other"), handler)).toThrow(/permissions\.tools.*other/);
    expect(ctx.registeredTools.map((t) => t.spec.name)).toEqual(["echo"]);
    await ctx.close();
    expect(await denials()).toHaveLength(1);
  });

  it("自动授予的基础能力无需声明", async () => {
    const ctx = createPluginContext(deps, mf({ provides: ["counter@1"] }), { a: 1 });
    expect(ctx.kv).toBeDefined();
    expect(ctx.lock).toBeDefined();
    expect(ctx.bus).toBeDefined();
    expect(ctx.queue).toBeDefined();
    expect(ctx.log).toBeDefined();
    expect(ctx.db).toBeDefined();
    expect(ctx.config).toEqual({ a: 1 });
    ctx.provide("counter@1", {});
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("审计写入失败只记 warn，不影响抛出的 PluginPermissionError", async () => {
    const warn = vi.fn();
    const broken = {
      ...deps,
      log: { ...quiet, warn },
      db: createDb("postgres://x@127.0.0.1:1/x", 1),
    };
    const ctx = createPluginContext(broken, mf({ name: "perm-broken" }), {});
    expect(() => ctx.secrets).toThrow(PluginPermissionError);
    await ctx.close();
    await broken.db.destroy();
    expect(warn).toHaveBeenCalledWith(
      "plugin permission denial audit failed",
      expect.objectContaining({ plugin: "perm-broken" }),
    );
    // 写审计失败时去重键被撤销，下次仍会尝试记录
    expect(await redis.keys("capk:*")).toEqual([]);
  });
});
