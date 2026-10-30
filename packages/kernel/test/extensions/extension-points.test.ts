import { fileURLToPath } from "node:url";
import {
  defineExtension,
  type ExtensionContext,
  type ExtensionManifest,
  ExtensionPermissionError,
  type ExtensionPointRef,
  ExtensionPointUnavailableError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import {
  createExtensionContext,
  type ExtensionPointAccess,
  type KernelDeps,
} from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import { testHost } from "../helpers/extensions.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: ExtensionHost[] = [];
const quiet = { info() {}, warn() {}, error() {} };
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

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
    locks: new LockService(redis, createLogger("error")),
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    embedTokens: new EmbedTokens(createKeyring(Buffer.alloc(32, 1), [])),
    runWorkers: false,
    log: quiet,
  };
}, 120_000);
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

const mf = (over: Partial<ExtensionManifest> = {}) =>
  defineExtension({
    name: "cap-test",
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    setup() {},
    ...over,
  });

/** 测试用的能力访问：固定的提供方表与组织启用表，并记录启用查询次数（验证不缓存）。 */
const stubAccess = (
  table: Partial<Record<ExtensionPointRef, { plugin: string; impl: unknown }[]>>,
  enabled: Record<string, string[]> = {},
) => {
  const calls: string[] = [];
  const access: ExtensionPointAccess = {
    providers: (ref) => table[ref] ?? [],
    async enabledPlugins(orgId) {
      calls.push(orgId);
      return new Set(enabled[orgId] ?? []);
    },
  };
  return { access, calls };
};

describe("ctx.extensionPoints（单元）", () => {
  it("取未声明的能力：抛 ExtensionPermissionError", async () => {
    const { access } = stubAccess({ "counter@1": [{ plugin: "p", impl: 1 }] });
    const ctx = createExtensionContext(deps, mf(), {}, access);
    expect(() => ctx.extensionPoints.get("counter@1", "p")).toThrow(ExtensionPermissionError);
    expect(() => ctx.extensionPoints.list("counter@1")).toThrow(/counter@1/);
    await ctx.close();
  });

  it("取 brokered 能力：抛错（只能经平台能力使用）", async () => {
    const { access } = stubAccess({ "model-provider@2": [{ plugin: "p", impl: 1 }] });
    const ctx = createExtensionContext(deps, mf(), {}, access);
    expect(() => ctx.extensionPoints.get("model-provider@2", "p")).toThrow(/brokered/);
    expect(() => ctx.extensionPoints.list("connector@1")).toThrow(/brokered/);
    await ctx.close();
  });

  it("多选能力 get 必须给 provider；provider 不存在抛 ExtensionPointUnavailableError", async () => {
    const { access } = stubAccess({ "counter@1": [{ plugin: "p", impl: { v: 1 } }] });
    const ctx = createExtensionContext(deps, mf({ requires: ["counter@1"] }), {}, access);
    expect(() => ctx.extensionPoints.get("counter@1")).toThrow(/multi-provider.*p/);
    expect(ctx.extensionPoints.get("counter@1", "p")).toEqual({ v: 1 });
    expect(() => ctx.extensionPoints.get("counter@1", "q")).toThrow(ExtensionPointUnavailableError);
    expect(ctx.extensionPoints.list("counter@1")).toEqual([{ plugin: "p", impl: { v: 1 } }]);
    await ctx.close();
  });

  it("单选能力 get 无需 provider", async () => {
    const { access } = stubAccess({ "config-source@1": [{ plugin: "nacos", impl: "x" }] });
    const ctx = createExtensionContext(deps, mf({ requires: ["config-source@1"] }), {}, access);
    expect(ctx.extensionPoints.get("config-source@1")).toBe("x");
    await ctx.close();
  });

  it("optional 能力缺失：list 为空，get 抛 ExtensionPointUnavailableError", async () => {
    const { access } = stubAccess({});
    const ctx = createExtensionContext(deps, mf({ optional: ["directory@1"] }), {}, access);
    expect(ctx.extensionPoints.list("directory@1")).toEqual([]);
    expect(() => ctx.extensionPoints.get("directory@1", "x")).toThrow(
      ExtensionPointUnavailableError,
    );
    await ctx.close();
  });

  it("orgScoped 能力传 orgId：按组织启用过滤，未启用抛 ExtensionPointUnavailableError，每次都查询", async () => {
    const { access, calls } = stubAccess(
      {
        "channel@1": [
          { plugin: "a", impl: "A" },
          { plugin: "b", impl: "B" },
        ],
      },
      { o1: ["a"] },
    );
    const ctx = createExtensionContext(deps, mf({ requires: ["channel@1"] }), {}, access);
    await expect(ctx.extensionPoints.get("channel@1", "a", { orgId: "o1" })).resolves.toBe("A");
    await expect(ctx.extensionPoints.get("channel@1", "b", { orgId: "o1" })).rejects.toThrow(
      ExtensionPointUnavailableError,
    );
    await expect(ctx.extensionPoints.list("channel@1", { orgId: "o1" })).resolves.toEqual([
      { plugin: "a", impl: "A" },
    ]);
    await expect(ctx.extensionPoints.list("channel@1", { orgId: "o2" })).resolves.toEqual([]);
    expect(calls).toEqual(["o1", "o1", "o1", "o2"]);
    // 不传 orgId：部署级视角，不查询组织启用
    expect(ctx.extensionPoints.list("channel@1")).toHaveLength(2);
    expect(calls).toHaveLength(4);
    await ctx.close();
  });

  it("非 orgScoped 能力传 orgId：不查组织启用", async () => {
    const { access, calls } = stubAccess({ "identity-source@1": [{ plugin: "a", impl: "A" }] });
    const ctx = createExtensionContext(deps, mf({ requires: ["identity-source@1"] }), {}, access);
    await expect(ctx.extensionPoints.get("identity-source@1", "a", { orgId: "o1" })).resolves.toBe(
      "A",
    );
    await expect(ctx.extensionPoints.list("identity-source@1", { orgId: "o1" })).resolves.toEqual([
      { plugin: "a", impl: "A" },
    ]);
    expect(calls).toEqual([]);
    await ctx.close();
  });
});

describe("ctx.extensionPoints (through ExtensionHost)", () => {
  it("依赖按拓扑序加载，setup 内可取用被依赖方；optional 缺失时 list 为空；按组织启用取用", async () => {
    const h = testHost(deps, {}, { registry: new ExtensionRegistry(), autoApprove: true });
    hosts.push(h);
    await h.load([fx("cap-consumer"), fx("cap-chan-a"), fx("cap-chan-b")]);
    expect(h.manifests().map((m) => m.name)).toEqual(["cap-chan-a", "cap-chan-b", "cap-consumer"]);
    expect(h.get("counter@1", "cap-consumer")).toEqual({
      channels: ["cap-chan-a:a", "cap-chan-b:b"],
      directories: 0,
      picked: "b",
    });

    const ctx = (globalThis as { __capCtx?: ExtensionContext }).__capCtx as ExtensionContext;
    await sql`INSERT INTO capybara.orgs (id, slug, name) VALUES ('org-cap', 'org-cap', 'Cap')`.execute(
      deps.db,
    );
    await expect(
      ctx.extensionPoints.get("channel@1", "cap-chan-a", { orgId: "org-cap" }),
    ).rejects.toThrow(ExtensionPointUnavailableError);
    await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
      VALUES ('cap-chan-a', 'org-cap', true), ('cap-chan-b', 'org-cap', false)`.execute(deps.db);
    await expect(
      ctx.extensionPoints.get<{ id: string }>("channel@1", "cap-chan-a", { orgId: "org-cap" }),
    ).resolves.toEqual({ id: "a" });
    await expect(
      ctx.extensionPoints.get("channel@1", "cap-chan-b", { orgId: "org-cap" }),
    ).rejects.toThrow(/cap-chan-b.*org-cap/);
    expect(
      (await ctx.extensionPoints.list("channel@1", { orgId: "org-cap" })).map((e) => e.plugin),
    ).toEqual(["cap-chan-a"]);
    // 不缓存：组织停用后立即生效
    await sql`UPDATE capybara.extension_org_configs SET enabled = false WHERE plugin = 'cap-chan-a'`.execute(
      deps.db,
    );
    await expect(ctx.extensionPoints.list("channel@1", { orgId: "org-cap" })).resolves.toEqual([]);
  });
});
