import { fileURLToPath } from "node:url";
import { defineExtension, type ExtensionManifest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { planApprovals } from "../../src/extensions/approvals.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import {
  computePermissionSet,
  type PermissionSet,
  permissionKeys,
} from "../../src/extensions/permission-set.js";
import {
  isSensitivePermissionKey,
  permissionGroups,
  permissionKeyItems,
} from "../../src/extensions/permission-view.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { approvalsFor, testHost } from "../helpers/extensions.js";

/**
 * 界面权限（spec §4.1、审查重点 5）：`ui.view:*` 记入快照但不卡加载（升级时自动补进快照，不写审计、记日志）；
 * `ui.embed:*` 与其他新增权限一样卡加载；权限清单的 `ui` 分组含 embed 时为敏感。
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

const manifest = (ui: ExtensionManifest["permissions"]) =>
  defineExtension({
    name: "ui-demo",
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    ui: [
      ...(ui?.ui?.views ?? []).map((id) => ({
        id,
        title: { zh: id, en: id },
        place: "conversation" as const,
        kind: "view" as const,
      })),
      ...(ui?.ui?.embeds ?? []).map((id) => ({
        id,
        title: { zh: id, en: id },
        place: "page" as const,
        kind: "embed" as const,
        path: "/ui/x",
      })),
    ],
    permissions: ui ?? {},
    setup() {},
  });

describe("permissionKeys / permissionGroups 的 ui 项", () => {
  it("views → ui.view:<id>，embeds → ui.embed:<id>；旧快照缺 ui 时按空处理", async () => {
    const set = await computePermissionSet(
      manifest({
        http: [{ method: "GET", path: "/ui/x" }],
        ui: { views: ["tasks", "notes"], embeds: ["board"] },
      }),
      "/tmp",
    );
    expect(set.permissions.ui).toEqual({ views: ["notes", "tasks"], embeds: ["board"] });
    expect(permissionKeys(set)).toEqual([
      "permissions.http:GET /ui/x",
      "ui.embed:board",
      "ui.view:notes",
      "ui.view:tasks",
    ]);
    const old = structuredClone(set) as PermissionSet;
    delete (old.permissions as Partial<PermissionSet["permissions"]>).ui;
    expect(permissionKeys(old)).toEqual(["permissions.http:GET /ui/x"]);
  });

  it("ui 分组：只有 view 时不敏感；含 embed 时敏感", async () => {
    const views = await computePermissionSet(manifest({ ui: { views: ["tasks"] } }), "/tmp");
    expect(permissionGroups(views).find((g) => g.category === "ui")).toEqual({
      category: "ui",
      sensitive: false,
      items: ["view:tasks"],
      entries: [{ value: "view:tasks", sensitive: false }],
    });
    const both = await computePermissionSet(
      manifest({
        http: [{ method: "GET", path: "/ui/x" }],
        ui: { views: ["tasks"], embeds: ["board"] },
      }),
      "/tmp",
    );
    expect(permissionGroups(both).find((g) => g.category === "ui")).toEqual({
      category: "ui",
      sensitive: true,
      items: ["view:tasks", "embed:board"],
      entries: [
        { value: "view:tasks", sensitive: false },
        { value: "embed:board", sensitive: true, reason: "ui_embed" },
      ],
    });
  });
});

describe("permissionKeyItems：权限键逐项的敏感标记与原因码", () => {
  it("与 isSensitivePermissionKey 一致，并给出原因码", () => {
    expect(
      permissionKeyItems([
        "permissions.secrets",
        "config.org.secret:token",
        "permissions.http.public:GET /hook",
        "permissions.tools:echo",
        "permissions.hooks:run.start",
        "provides:sandbox@1",
        "provides:object-store@1",
        "provides:identity-source@1",
        "ui.embed:board",
        "ui.view:tasks",
        "provides:counter@1",
        "permissions.network:api.example.com",
      ]),
    ).toEqual([
      { value: "permissions.secrets", sensitive: true, reason: "secrets" },
      { value: "config.org.secret:token", sensitive: true, reason: "secrets" },
      { value: "permissions.http.public:GET /hook", sensitive: true, reason: "public_routes" },
      { value: "permissions.tools:echo", sensitive: true, reason: "tools" },
      { value: "permissions.hooks:run.start", sensitive: true, reason: "hooks" },
      { value: "provides:sandbox@1", sensitive: true, reason: "sandbox" },
      { value: "provides:object-store@1", sensitive: true, reason: "object_store" },
      { value: "provides:identity-source@1", sensitive: true, reason: "identity_source" },
      { value: "ui.embed:board", sensitive: true, reason: "ui_embed" },
      { value: "ui.view:tasks", sensitive: false },
      { value: "provides:counter@1", sensitive: false },
      { value: "permissions.network:api.example.com", sensitive: false },
    ]);
  });
});

describe("isSensitivePermissionKey：与 permissionGroups 同一套敏感类别", () => {
  it("密钥、公开路由、工具、hook、敏感能力、embed 为敏感；其余不是", () => {
    const sensitive = [
      "permissions.secrets",
      "config.org.secret:apiKey",
      "config.deployment.secret:<root>",
      "permissions.http.public:POST /events",
      "permissions.tools:write",
      "permissions.hooks:run.completed",
      "provides:channel@1",
      "provides:directory@1",
      "provides:identity-source@1",
      "ui.embed:board",
    ];
    const plain = [
      "provides:counter@1",
      "requires:channel@1",
      "config.org:region",
      "table:todos",
      "permissions.http:GET /a",
      "permissions.network:a.example.com",
      "permissions.models:x (chat)",
      "permissions.storage",
      "ui.view:tasks",
    ];
    for (const k of sensitive) expect(isSensitivePermissionKey(k), k).toBe(true);
    for (const k of plain) expect(isSensitivePermissionKey(k), k).toBe(false);
  });

  it("与 permissionGroups 一致：敏感分组里的每一项对应的键都敏感", async () => {
    const set = await computePermissionSet(
      manifest({
        secrets: true,
        tools: ["write"],
        http: [
          { method: "GET", path: "/ui/x" },
          { method: "POST", path: "/hook", public: true },
        ],
        network: ["a.example.com"],
        ui: { views: ["tasks"], embeds: ["board"] },
      }),
      "/tmp",
    );
    const keys = permissionKeys(set);
    const flagged = keys.filter(isSensitivePermissionKey).sort();
    expect(flagged).toEqual([
      "permissions.http.public:POST /hook",
      "permissions.secrets",
      "permissions.tools:write",
      "ui.embed:board",
    ]);
  });
});

describe("planApprovals：ui.view 不卡加载，ui.embed 卡加载", () => {
  const snap = (permissions: PermissionSet) =>
    new Map([
      [
        "ui-demo",
        {
          plugin: "ui-demo",
          version: "0.1.0",
          permissions,
          approvedBy: null,
          approvedAt: new Date(),
          source: "cli" as const,
        },
      ],
    ]);

  it("只多出 view → 加载（不算 autoApprove），快照需更新；多出 embed → 待批准", async () => {
    const before = await computePermissionSet(manifest({}), "/tmp");
    const view = manifest({ ui: { views: ["tasks"] } });
    const viewSet = await computePermissionSet(view, "/tmp");
    const [d1] = planApprovals([view], new Map([["ui-demo", viewSet]]), snap(before));
    expect(d1).toMatchObject({
      action: "load",
      autoApprove: false,
      changed: true,
      added: ["ui.view:tasks"],
    });

    const embed = manifest({
      http: [{ method: "GET", path: "/ui/x" }],
      ui: { views: ["tasks"], embeds: ["board"] },
    });
    const withRoute = await computePermissionSet(
      manifest({ http: [{ method: "GET", path: "/ui/x" }], ui: { views: ["tasks"] } }),
      "/tmp",
    );
    const embedSet = await computePermissionSet(embed, "/tmp");
    const [d2] = planApprovals([embed], new Map([["ui-demo", embedSet]]), snap(withRoute));
    expect(d2).toMatchObject({
      action: "pending",
      pending: { reason: "added", added: ["ui.embed:board"] },
    });
  });

  it("全新插件（没有快照）即使只有 view 也要批准", async () => {
    const view = manifest({ ui: { views: ["tasks"] } });
    const [d] = planApprovals(
      [view],
      new Map([["ui-demo", await computePermissionSet(view, "/tmp")]]),
      new Map(),
    );
    expect(d?.action).toBe("pending");
  });
});

describe("ExtensionHost.load: an extension upgrade adds a view / embed (review focus 5)", () => {
  let pg: Awaited<ReturnType<typeof startTestPostgres>>;
  let rd: Awaited<ReturnType<typeof startTestRedis>>;
  let deps: KernelDeps;
  let redis: Redis;
  let sub: ReturnType<typeof createBusSubscriber>;
  const hosts: ExtensionHost[] = [];
  const logs: { level: string; msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      logs.push({ level, msg, fields });
    };

  const host = () => {
    const h = testHost(deps, {}, { registry: new ExtensionRegistry() });
    hosts.push(h);
    return h;
  };
  const snapshot = async () =>
    kernelDb(deps.db)
      .selectFrom("extension_permission_snapshots")
      .selectAll()
      .where("plugin", "=", "ui-a")
      .executeTakeFirst();
  const auditRows = async () =>
    kernelDb(deps.db).selectFrom("audit_events").select("action").execute();

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
      runWorkers: false,
      log: { info: at("info"), warn: at("warn"), error: at("error") },
    };
  }, 120_000);
  afterAll(async () => {
    await sub?.close();
    redis?.disconnect();
    await deps?.db.destroy();
    await Promise.all([pg?.stop(), rd?.stop()]);
  });
  beforeEach(async () => {
    logs.length = 0;
    await sql`TRUNCATE capybara.extension_permission_snapshots, capybara.audit_events`.execute(
      deps.db,
    );
    // 批准 0.1.0（模拟 `capybara extensions approve`）
    const [p] = await ExtensionHost.inspect([fx("ui-a")]);
    if (!p) throw new Error("fixture missing");
    await approvalsFor(deps.db).approve("ui-a", "0.1.0", p.permissions, {
      source: "cli",
    });
  });
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.close()));
  });

  it("多出 view → 照常加载，快照补上 ui.view:tasks（来源不变、不写审计），记一条 info 日志", async () => {
    const h = host();
    await h.load([fx("ui-a-view")]);
    expect(h.manifests().map((m) => `${m.name}@${m.version}`)).toEqual(["ui-a@0.2.0"]);
    expect(h.pending()).toEqual([]);
    const snap = await snapshot();
    expect(snap?.version).toBe("0.2.0");
    expect(snap?.source).toBe("cli");
    expect(permissionKeys(snap?.permissions as PermissionSet)).toContain("ui.view:tasks");
    expect(await auditRows()).toEqual([]);
    const merged = logs.find((l) => l.level === "info" && l.fields?.plugin === "ui-a");
    expect(merged?.fields).toMatchObject({ version: "0.2.0", merged: ["ui.view:tasks"] });
  });

  it("快照已补上 view 之后，旧版本副本（0.1.0）重启照常加载，快照不变", async () => {
    await host().load([fx("ui-a-view")]);
    await Promise.all(hosts.splice(0).map((h) => h.close()));
    const old = host();
    await old.load([fx("ui-a")]);
    expect(old.manifests().map((m) => m.version)).toEqual(["0.1.0"]);
    expect(old.pending()).toEqual([]);
    const snap = await snapshot();
    expect(snap?.version).toBe("0.2.0");
    expect(permissionKeys(snap?.permissions as PermissionSet)).toContain("ui.view:tasks");
  });

  it("多出 embed → 待批准、不加载，快照不变", async () => {
    // 先让 0.2.0 加载（快照补上 view），再升级到带 embed 的 0.3.0
    await host().load([fx("ui-a-view")]);
    await Promise.all(hosts.splice(0).map((h) => h.close()));
    const h = host();
    await h.load([fx("ui-a-embed")]);
    expect(h.manifests()).toEqual([]);
    expect(h.pending()).toEqual([
      { plugin: "ui-a", version: "0.3.0", reason: "added", added: ["ui.embed:board"], removed: [] },
    ]);
    expect((await snapshot())?.version).toBe("0.2.0");
  });
});
