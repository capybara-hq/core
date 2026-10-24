import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  type PluginManifest,
  parseCatalogIndex,
  secret,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPermissionSet,
  computePermissionSet,
  diffPermissions,
  parseCreatedTables,
  permissionKeys,
} from "../../src/plugins/permission-set.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "perm-set-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mf = (over: Partial<PluginManifest> = {}) =>
  definePlugin({
    name: "perm-demo",
    version: "1.0.0",
    sdk: "^0.1.0",
    provides: [],
    setup() {},
    ...over,
  });

describe("parseCreatedTables", () => {
  it("识别 CREATE TABLE [IF NOT EXISTS] [schema.]name：大小写、引号、注释、其他语句忽略", () => {
    const sql = `
      -- create table commented_out (id int);
      /* CREATE TABLE also_commented (id int); */
      create table if not exists items (id int);
      CREATE TABLE "Mixed""Case" (id int);
      Create Unlogged Table  IF  NOT  EXISTS plugin_perm_demo.own_schema (id int);
      CREATE TEMP TABLE scratch (id int);
      CREATE TABLE other_schema.foreign_one (id int);
      CREATE INDEX IF NOT EXISTS items_idx ON items (id);
      ALTER TABLE items ADD COLUMN IF NOT EXISTS label text;
      create table items (id int);
    `;
    expect(parseCreatedTables(sql, "plugin_perm_demo")).toEqual([
      "items",
      'Mixed"Case',
      "own_schema",
      "scratch",
      "other_schema.foreign_one",
      "items",
    ]);
  });
});

describe("computePermissionSet", () => {
  it("汇总 provides / requires / optional / 配置字段 / 数据表 / permissions，并规范化排序", async () => {
    const mig = join(dir, "m1");
    await mkdir(mig);
    await writeFile(join(mig, "0002_more.sql"), "CREATE TABLE IF NOT EXISTS zeta (id int);");
    await writeFile(join(mig, "0001_init.sql"), "create table if not exists alpha (id int);");
    await writeFile(join(mig, "README.md"), "CREATE TABLE not_a_migration (id int);");
    const set = await computePermissionSet(
      mf({
        provides: ["counter@1"],
        requires: ["directory@1"],
        optional: ["channel@1"],
        config: {
          deployment: z.object({
            region: z.string(),
            nested: z.object({ key: secret(z.string()) }),
          }),
          org: z.object({ apiKey: secret(z.string()), enabledFlag: z.boolean().default(false) }),
        },
        migrations: "./m1",
        permissions: {
          tools: ["write", "read"],
          secrets: true,
          http: [
            { method: "POST", path: "/hook", public: true },
            { method: "GET", path: "/a" },
          ],
          network: ["b.example.com", "a.example.com"],
          models: [{ purpose: "perm-demo.sum", kind: "chat", label: { zh: "摘要", en: "Sum" } }],
        },
      }),
      dir,
    );
    expect(set).toEqual({
      provides: ["counter@1"],
      requires: ["directory@1"],
      optional: ["channel@1"],
      config: {
        deployment: [
          { path: "nested.key", secret: true },
          { path: "region", secret: false },
        ],
        org: [
          { path: "apiKey", secret: true },
          { path: "enabledFlag", secret: false },
        ],
      },
      tables: ["alpha", "zeta"],
      permissions: {
        secrets: true,
        storage: false,
        http: [
          { method: "GET", path: "/a", public: false },
          { method: "POST", path: "/hook", public: true },
        ],
        tools: ["read", "write"],
        hooks: [],
        models: [{ purpose: "perm-demo.sum", kind: "chat" }],
        network: ["a.example.com", "b.example.com"],
        ui: { views: [], embeds: [] },
      },
    });
    expect(permissionKeys(set)).toEqual(
      [
        "config.deployment.secret:nested.key",
        "config.deployment:region",
        "config.org.secret:apiKey",
        "config.org:enabledFlag",
        "optional:channel@1",
        "permissions.http.public:POST /hook",
        "permissions.http:GET /a",
        "permissions.models:perm-demo.sum (chat)",
        "permissions.network:a.example.com",
        "permissions.network:b.example.com",
        "permissions.secrets",
        "permissions.tools:read",
        "permissions.tools:write",
        "provides:counter@1",
        "requires:directory@1",
        "table:alpha",
        "table:zeta",
      ].sort(),
    );
  });

  it("没有迁移、配置与 permissions 时为空集合", async () => {
    const set = await computePermissionSet(mf(), dir);
    expect(permissionKeys(set)).toEqual([]);
  });

  it("迁移目录不存在 → 抛错点名插件", async () => {
    await expect(computePermissionSet(mf({ migrations: "./nope" }), dir)).rejects.toThrow(
      /perm-demo/,
    );
  });
});

describe("diffPermissions", () => {
  it("按稳定键给出新增与减少；prev 为空表示全部新增", async () => {
    const a = await computePermissionSet(mf({ permissions: { tools: ["a", "b"] } }), dir);
    const b = await computePermissionSet(
      mf({ permissions: { tools: ["b", "c"], secrets: true } }),
      dir,
    );
    expect(diffPermissions(a, b)).toEqual({
      added: ["permissions.secrets", "permissions.tools:c"],
      removed: ["permissions.tools:a"],
    });
    expect(diffPermissions(undefined, a)).toEqual({
      added: ["permissions.tools:a", "permissions.tools:b"],
      removed: [],
    });
  });

  it("旧快照缺字段（格式演进）按空处理，不抛错", async () => {
    const b = await computePermissionSet(mf({ permissions: { tools: ["x"] } }), dir);
    expect(diffPermissions({ provides: [] } as never, b)).toEqual({
      added: ["permissions.tools:x"],
      removed: [],
    });
  });
});

describe("permissionKeys and catalog indexes", () => {
  it("every key category, policy hooks included, is a valid catalog permission key (N-1)", () => {
    const set = buildPermissionSet({
      provides: ["channel@1"],
      requires: ["model-provider@2"],
      optional: ["directory@1"],
      config: {
        deployment: [{ path: "apiKey", secret: true }],
        org: [{ path: "team", secret: false }],
      },
      tables: ["todos"],
      permissions: {
        secrets: true,
        storage: true,
        http: [
          { method: "GET", path: "/x" },
          { method: "POST", path: "/events", public: true },
        ],
        tools: ["write"],
        hooks: ["model.request", "tool.preExecute", "usage.report"],
        policyHooks: ["model.request", "tool.preExecute"],
        network: ["api.example.com"],
        ui: { views: ["tasks"], embeds: ["board"] },
      },
      warningsDigest: "abc123",
    });
    const keys = permissionKeys(set);
    expect(keys).toContain("permissions.hooks.policy:model.request");
    expect(keys).toContain("permissions.hooks.policy:tool.preExecute");
    const r = parseCatalogIndex({
      schemaVersion: 1,
      name: "Enterprise",
      updatedAt: "2026-10-24T00:00:00Z",
      entries: [
        {
          kind: "plugin",
          name: "guard",
          npm: "@acme/plugin-guard",
          publisher: "Acme",
          summary: { en: "Guard" },
          permissions: { keys, sensitive: keys.filter((k) => k.startsWith("permissions.hooks")) },
          versions: [
            {
              version: "1.0.0",
              integrity: `sha512-${"A".repeat(86)}==`,
              minKernel: "0.1.0",
              minSdk: "0.1.0",
            },
          ],
        },
      ],
    });
    expect("errors" in r ? r.errors : []).toEqual([]);
  });
});
