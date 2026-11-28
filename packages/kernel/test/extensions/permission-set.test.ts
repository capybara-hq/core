import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineExtension,
  type ExtensionManifest,
  parseMarketplaceManifest,
  secret,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  blockingKeys,
  buildPermissionSet,
  computePermissionSet,
  diffPermissions,
  parseCreatedTables,
  permissionKeys,
} from "../../src/extensions/permission-set.js";
import {
  isSensitivePermissionKey,
  permissionGroups,
  permissionKeyItems,
} from "../../src/extensions/permission-view.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "perm-set-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mf = (over: Partial<ExtensionManifest> = {}) =>
  defineExtension({
    name: "perm-demo",
    version: "1.0.0",
    sdk: "^0.1.0-rc.0",
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
        },
        migrations: "./m1",
        permissions: {
          tools: ["write", "read"],
          secrets: true,
          http: [
            { method: "POST", path: "/hook", access: "public" },
            { method: "GET", path: "/a", access: "member" },
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
      },
      tables: ["alpha", "zeta"],
      permissions: {
        secrets: true,
        storage: false,
        http: [
          { method: "GET", path: "/a", access: "member" },
          { method: "POST", path: "/hook", access: "public" },
        ],
        tools: ["read", "write"],
        hooks: [],
        models: [{ purpose: "perm-demo.sum", kind: "chat" }],
        network: ["a.example.com", "b.example.com"],
        client: false,
        ui: { views: [], embeds: [], components: [] },
      },
    });
    expect(permissionKeys(set)).toEqual(
      [
        "config.deployment.secret:nested.key",
        "config.deployment:region",
        "optional:channel@1",
        "permissions.http.member:GET /a",
        "permissions.http.public:POST /hook",
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

  it("changing a route's access is a new item: the old key goes, the new key needs approval", async () => {
    const pub = await computePermissionSet(
      mf({ permissions: { http: [{ method: "GET", path: "/ui/data", access: "public" }] } }),
      dir,
    );
    const emb = await computePermissionSet(
      mf({ permissions: { http: [{ method: "GET", path: "/ui/data", access: "embed" }] } }),
      dir,
    );
    expect(diffPermissions(pub, emb)).toEqual({
      added: ["permissions.http.embed:GET /ui/data"],
      removed: ["permissions.http.public:GET /ui/data"],
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

describe("permissionKeys and marketplace manifests", () => {
  it("every key category, policy hooks included, is a valid marketplace permission key (N-1)", () => {
    const set = buildPermissionSet({
      provides: ["channel@1"],
      requires: ["model-provider@2"],
      optional: ["directory@1"],
      config: {
        deployment: [
          { path: "apiKey", secret: true },
          { path: "team", secret: false },
        ],
      },
      tables: ["todos"],
      permissions: {
        secrets: true,
        storage: true,
        http: [
          { method: "GET", path: "/x", access: "admin" },
          { method: "POST", path: "/events", access: "public" },
        ],
        tools: ["write"],
        hooks: ["model.request", "tool.preExecute", "usage.report"],
        policyHooks: ["model.request", "tool.preExecute"],
        network: ["api.example.com"],
        ui: { views: ["tasks"], embeds: ["board"] },
        dialIn: { protocol: "capybara-device/5" },
      },
      warningsDigest: "abc123",
    });
    const keys = permissionKeys(set);
    expect(keys).toContain("permissions.hooks.policy:model.request");
    expect(keys).toContain("permissions.dialin:capybara-device/5");
    expect(keys).toContain("permissions.hooks.policy:tool.preExecute");
    const r = parseMarketplaceManifest({
      schemaVersion: 1,
      name: "Enterprise",
      plugins: [
        {
          name: "guard",
          summary: { en: "Guard" },
          permissions: { keys, sensitive: keys.filter((k) => k.startsWith("permissions.hooks")) },
          source: {
            npm: {
              package: "@acme/plugin-guard",
              version: "1.0.0",
              integrity: `sha512-${"A".repeat(86)}==`,
            },
          },
        },
      ],
    });
    expect("errors" in r ? r.errors : []).toEqual([]);
  });
});

describe("permissions.dialIn", () => {
  it("a declared dial-in protocol is a blocking key; a changed protocol is a new item", () => {
    const set = (protocol?: string) =>
      buildPermissionSet({
        provides: ["device-provider@1"],
        config: { deployment: [] },
        tables: [],
        permissions: protocol ? { dialIn: { protocol } } : {},
      });
    expect(set("fake-dial-in/1").permissions.dialIn).toEqual({ protocol: "fake-dial-in/1" });
    expect(permissionKeys(set("fake-dial-in/1"))).toContain("permissions.dialin:fake-dial-in/1");
    // a set without one stays as it was (older snapshots compare equal)
    expect(set().permissions).not.toHaveProperty("dialIn");
    expect(diffPermissions(set("fake-dial-in/1"), set("fake-dial-in/2"))).toEqual({
      added: ["permissions.dialin:fake-dial-in/2"],
      removed: ["permissions.dialin:fake-dial-in/1"],
    });
    expect(blockingKeys(["permissions.dialin:fake-dial-in/2"])).toEqual([
      "permissions.dialin:fake-dial-in/2",
    ]);
  });

  it("the approval display lists the protocol in its own group", () => {
    const groups = permissionGroups(
      buildPermissionSet({
        provides: ["device-provider@1"],
        config: { deployment: [] },
        tables: [],
        permissions: { dialIn: { protocol: "fake-dial-in/1" } },
      }),
    );
    expect(groups.find((g) => g.category === "dialIn")).toMatchObject({
      items: ["fake-dial-in/1"],
    });
    expect(permissionKeyItems(["permissions.dialin:fake-dial-in/1"])).toEqual([
      { value: "permissions.dialin:fake-dial-in/1", sensitive: false },
    ]);
  });
});

describe("permissions.deviceAccess", () => {
  const set = (services?: string[]) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [] },
      tables: [],
      permissions: services ? { deviceAccess: { services } } : {},
    });

  it("each declared service is a blocking key; a set without it stays as it was", () => {
    expect(set(["b", "a", "a"]).permissions.deviceAccess).toEqual({ services: ["a", "b"] });
    expect(permissionKeys(set(["browser"]))).toContain("permissions.deviceaccess:browser");
    expect(set().permissions).not.toHaveProperty("deviceAccess");
    expect(blockingKeys(["permissions.deviceaccess:browser"])).toEqual([
      "permissions.deviceaccess:browser",
    ]);
  });

  it("an upgrade adding deviceAccess or a service adds blocking keys (re-approval)", () => {
    expect(diffPermissions(set(), set(["browser"]))).toEqual({
      added: ["permissions.deviceaccess:browser"],
      removed: [],
    });
    const d = diffPermissions(set(["browser"]), set(["browser", "recorder"]));
    expect(d).toEqual({ added: ["permissions.deviceaccess:recorder"], removed: [] });
    expect(blockingKeys(d.added)).toEqual(["permissions.deviceaccess:recorder"]);
  });

  it("the keys are valid marketplace permission keys", () => {
    const keys = permissionKeys(set(["browser"]));
    const r = parseMarketplaceManifest({
      schemaVersion: 1,
      name: "Enterprise",
      plugins: [
        {
          name: "browser",
          summary: { en: "Browser" },
          permissions: { keys, sensitive: keys },
          source: {
            npm: {
              package: "@acme/plugin-browser",
              version: "1.0.0",
              integrity: `sha512-${"A".repeat(86)}==`,
            },
          },
        },
      ],
    });
    expect("errors" in r ? r.errors : []).toEqual([]);
  });

  it("the approval display lists the services in a sensitive group of their own", () => {
    const groups = permissionGroups(set(["browser"]));
    expect(groups.find((g) => g.category === "deviceAccess")).toMatchObject({
      items: ["browser"],
      sensitive: true,
      entries: [{ value: "browser", sensitive: true, reason: "device_access" }],
    });
    expect(permissionKeyItems(["permissions.deviceaccess:browser"])).toEqual([
      { value: "permissions.deviceaccess:browser", sensitive: true, reason: "device_access" },
    ]);
    expect(isSensitivePermissionKey("permissions.deviceaccess:browser")).toBe(true);
  });

  const withLoopback = (loopbackPorts?: boolean) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [] },
      tables: [],
      permissions: {
        deviceAccess: {
          services: ["browser"],
          ...(loopbackPorts !== undefined && { loopbackPorts }),
        },
      },
    });

  it("loopbackPorts is a blocking key recorded only when declared", () => {
    expect(withLoopback(true).permissions.deviceAccess).toEqual({
      services: ["browser"],
      loopbackPorts: true,
    });
    expect(permissionKeys(withLoopback(true))).toContain("permissions.deviceaccess.loopbackports");
    // false or absent: the set (and its keys) stay as they were
    expect(withLoopback(false).permissions.deviceAccess).toEqual({ services: ["browser"] });
    expect(permissionKeys(withLoopback(false))).toEqual(permissionKeys(set(["browser"])));
    expect(permissionKeys(withLoopback())).not.toContain("permissions.deviceaccess.loopbackports");
  });

  it("an upgrade adding loopbackPorts needs approval again", () => {
    const d = diffPermissions(withLoopback(), withLoopback(true));
    expect(d).toEqual({ added: ["permissions.deviceaccess.loopbackports"], removed: [] });
    expect(blockingKeys(d.added)).toEqual(["permissions.deviceaccess.loopbackports"]);
    // the key is a valid marketplace permission key
    const keys = permissionKeys(withLoopback(true));
    const r = parseMarketplaceManifest({
      schemaVersion: 1,
      name: "Enterprise",
      plugins: [
        {
          name: "browser",
          summary: { en: "Browser" },
          permissions: { keys, sensitive: keys },
          source: {
            npm: {
              package: "@acme/plugin-browser",
              version: "1.0.0",
              integrity: `sha512-${"A".repeat(86)}==`,
            },
          },
        },
      ],
    });
    expect("errors" in r ? r.errors : []).toEqual([]);
  });

  it("the approval display shows loopbackPorts declared at install as a sensitive item", () => {
    const groups = permissionGroups(withLoopback(true));
    expect(groups.find((g) => g.category === "deviceAccess")).toMatchObject({
      items: ["browser", "local ports on the device (loopback)"],
      sensitive: true,
      entries: [
        { value: "browser", sensitive: true, reason: "device_access" },
        {
          value: "local ports on the device (loopback)",
          sensitive: true,
          reason: "device_loopback_ports",
        },
      ],
    });
    expect(permissionKeyItems(["permissions.deviceaccess.loopbackports"])).toEqual([
      {
        value: "permissions.deviceaccess.loopbackports",
        sensitive: true,
        reason: "device_loopback_ports",
      },
    ]);
    expect(isSensitivePermissionKey("permissions.deviceaccess.loopbackports")).toBe(true);
  });
});

describe("permissions.triggers", () => {
  const set = (emit?: string[]) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [] },
      tables: [],
      permissions: emit ? { triggers: { emit } } : {},
    });

  it("each declared event type is a blocking key; a set without it stays as it was", () => {
    expect(set(["item.updated", "item.created", "item.created"]).permissions.triggers).toEqual({
      emit: ["item.created", "item.updated"],
    });
    expect(permissionKeys(set(["item.created"]))).toContain("permissions.triggers:item.created");
    expect(set().permissions).not.toHaveProperty("triggers");
    expect(blockingKeys(["permissions.triggers:item.created"])).toEqual([
      "permissions.triggers:item.created",
    ]);
  });

  it("an upgrade adding an event type adds a blocking key (re-approval)", () => {
    const d = diffPermissions(set(["item.created"]), set(["item.created", "item.assigned"]));
    expect(d).toEqual({ added: ["permissions.triggers:item.assigned"], removed: [] });
    expect(blockingKeys(d.added)).toEqual(["permissions.triggers:item.assigned"]);
  });

  it("the keys are valid marketplace permission keys", () => {
    const keys = permissionKeys(set(["item.created"]));
    const r = parseMarketplaceManifest({
      schemaVersion: 1,
      name: "Enterprise",
      plugins: [
        {
          name: "tracker",
          summary: { en: "Tracker" },
          permissions: { keys, sensitive: [] },
          source: {
            npm: {
              package: "@acme/plugin-tracker",
              version: "1.0.0",
              integrity: `sha512-${"A".repeat(86)}==`,
            },
          },
        },
      ],
    });
    expect("errors" in r ? r.errors : []).toEqual([]);
  });

  it("the approval display lists the event types in a group of their own, not sensitive", () => {
    const groups = permissionGroups(set(["item.created"]));
    expect(groups.find((g) => g.category === "triggers")).toMatchObject({
      items: ["item.created"],
      sensitive: false,
      entries: [{ value: "item.created", sensitive: false }],
    });
    expect(permissionKeyItems(["permissions.triggers:item.created"])).toEqual([
      { value: "permissions.triggers:item.created", sensitive: false },
    ]);
    expect(isSensitivePermissionKey("permissions.triggers:item.created")).toBe(false);
  });
});

describe("permissions.inbox", () => {
  const set = (inbox?: boolean) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [] },
      tables: [],
      permissions: inbox === undefined ? {} : { inbox },
    });

  it("is one blocking key when declared; a set without it stays as it was", () => {
    expect(set(true).permissions.inbox).toBe(true);
    expect(permissionKeys(set(true))).toContain("permissions.inbox");
    expect(set().permissions).not.toHaveProperty("inbox");
    expect(set(false).permissions).not.toHaveProperty("inbox");
    expect(blockingKeys(["permissions.inbox"])).toEqual(["permissions.inbox"]);
  });

  it("an upgrade declaring it adds a blocking key (re-approval)", () => {
    const d = diffPermissions(set(), set(true));
    expect(d).toEqual({ added: ["permissions.inbox"], removed: [] });
    expect(blockingKeys(d.added)).toEqual(["permissions.inbox"]);
  });

  it("the approval display lists it in a group of its own, not sensitive", () => {
    expect(permissionGroups(set(true)).find((g) => g.category === "inbox")).toEqual({
      category: "inbox",
      items: ["personal inbox items"],
      sensitive: false,
      entries: [{ value: "personal inbox items", sensitive: false }],
    });
    expect(permissionKeyItems(["permissions.inbox"])).toEqual([
      { value: "permissions.inbox", sensitive: false },
    ]);
    expect(isSensitivePermissionKey("permissions.inbox")).toBe(false);
  });
});

describe("permissions.agents / conversations / people", () => {
  const set = (permissions: Record<string, unknown>) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [] },
      tables: [],
      permissions: permissions as never,
    });
  const all = {
    agents: { read: true },
    conversations: { subjects: true },
    people: { read: true },
  };
  const KEYS = ["permissions.agents", "permissions.conversations", "permissions.people"];

  it("are one blocking, non-sensitive key each when declared", () => {
    const s = set(all);
    expect(permissionKeys(s)).toEqual(expect.arrayContaining(KEYS));
    expect(blockingKeys(KEYS)).toEqual(KEYS);
    for (const k of KEYS) expect(isSensitivePermissionKey(k)).toBe(false);
    expect(permissionKeyItems(KEYS).map((i) => i.sensitive)).toEqual([false, false, false]);
  });

  it("a set without them, or with them switched off, stays as it was", () => {
    for (const s of [set({}), set({ agents: { read: false }, people: {} })]) {
      expect(s.permissions).not.toHaveProperty("agents");
      expect(s.permissions).not.toHaveProperty("conversations");
      expect(s.permissions).not.toHaveProperty("people");
    }
  });

  it("an upgrade declaring them adds blocking keys (re-approval)", () => {
    const d = diffPermissions(set({}), set(all));
    expect([...d.added].sort()).toEqual([...KEYS].sort());
    expect(blockingKeys(d.added).sort()).toEqual([...KEYS].sort());
  });
});
