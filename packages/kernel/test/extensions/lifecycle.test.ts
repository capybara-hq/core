import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION, type ToolHandler } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionBlobs } from "../../src/extensions/blobs.js";
import type { ExtensionInstance } from "../../src/extensions/instance.js";
import { readExtensionPackage } from "../../src/extensions/package.js";
import { ReplicaStatusStore } from "../../src/extensions/sources.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * 插件免重启生命周期（T14，单副本）：安装 / 批准 / 启用 / 停用 / 升级 / 降级 / 卸载经后台接口写期望状态、
 * 发布 `kernel.plugins.changed`，本副本经 bus 订阅 reconcile 收敛；全程不重启内核。
 */

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const MAX_BYTES = 4 * 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const NOTES = {
  file: "0001_notes.sql",
  sql: "CREATE TABLE IF NOT EXISTS notes (id int PRIMARY KEY);\nINSERT INTO notes VALUES (1) ON CONFLICT DO NOTHING;\n",
};

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let orgId: string;

interface View {
  name: string;
  version: string;
  source: string;
  sha256: string | null;
  status: string;
  desired: { version: string; sha256: string; state: string } | null;
  added: string[];
  replicas: {
    replicaId: string;
    state: string;
    reason: string | null;
    version: string;
    servingVersion: string | null;
  }[];
  reviewHash: string;
}

const g = globalThis as {
  __lifeGate?: Promise<void>;
  __lifeSetups?: Record<string, string[]>;
  __lifeImports?: string[];
};

const upload = async (bytes: Uint8Array) => {
  const res = await admin({
    method: "POST",
    url: "/api/v1/admin/extensions/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { sha256: string; reviewHash: string; name: string };
};
const post = (path: string, payload?: Record<string, unknown>) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/extensions/${path}`,
    ...(payload !== undefined && { payload }),
  });
const view = async (name: string) => {
  const res = await admin({ method: "GET", url: `/api/v1/admin/extensions/${name}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as View;
};
const install = async (name: string, bytes: Uint8Array) => {
  const r = await upload(bytes);
  const res = await post(`${name}/install`, { sha256: r.sha256 });
  expect(res.statusCode, res.body).toBe(200);
  return { ...r, view: res.json() as View };
};
const approve = async (name: string) => {
  const v = await view(name);
  const res = await post(`${name}/approve`, { sha256: v.sha256, reviewHash: v.reviewHash });
  expect(res.statusCode, res.body).toBe(200);
};
const setState = async (name: string, state: "enable" | "disable") => {
  const res = await post(`${name}/${state}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as View;
};
/** 直接经实例的在途计数调用工具（与 ToolRegistry.handler 相同的路径）。 */
const callTool = (plugin: string) => {
  const t = k.host.tools().find((x) => x.plugin === plugin && x.spec.name === "wait");
  if (!t) throw new Error(`tool ${plugin}__wait is not available`);
  const signal = new AbortController().signal;
  return t.inflight.run(signal, (s) =>
    t.handler({}, { signal: s } as unknown as Parameters<ToolHandler>[1]),
  ) as Promise<{ content: { text: string }[] }>;
};
const loadedVersion = (name: string) => k.host.current(name)?.version;
const audits = (action: string, target: string) =>
  db
    .selectFrom("audit_events")
    .select(["detail", "actor_account_id"])
    .where("action", "=", action)
    .where("target", "=", target)
    .orderBy("at")
    .execute();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-lifecycle-"));
  await truncateTables(
    db,
    "capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE],
        extensionPermissions: { autoApprove: false },
        extensionHost: { dir: pluginsDir, drainSeconds: 30, reconcileIntervalSeconds: 3600 },
        packages: { maxBytes: MAX_BYTES },
      },
    ),
    { builtinExtensions: [S3_PLUGIN] },
  );
  const accounts = new AccountsService(db);
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
  orgId = await createOrg(admin);
}, 240_000);
afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

// 各用例按顺序依赖前一步的状态
describe("插件生命周期（单副本，不重启）", { timeout: 60_000 }, () => {
  let v1: Uint8Array;
  let v2: Uint8Array;

  it("错误码：内置 / 配置声明 / 包不存在 / 名字不符 / 未知插件", async () => {
    v1 = await lifePkg({ version: "1.0.0" });
    const r = await upload(v1);
    const cases: [string, Record<string, unknown> | undefined, number, string][] = [
      ["object-store-s3/install", { sha256: r.sha256 }, 409, "extension.builtin"],
      ["model-fake/install", { sha256: r.sha256 }, 409, "extension.config_declared"],
      ["life/install", { sha256: "0".repeat(64) }, 404, "extension.package_not_found"],
      ["other/install", { sha256: r.sha256 }, 409, "extension.name_mismatch"],
      ["life/install", { sha256: "nothex" }, 400, "validation_failed"],
      ["nope/enable", undefined, 404, "extension.not_found"],
      ["object-store-s3/disable", undefined, 409, "extension.builtin"],
      ["model-fake/disable", undefined, 409, "extension.config_declared"],
    ];
    for (const [path, body, status, code] of cases) {
      const res = await post(path, body);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(status);
      expect(res.json().error.code, path).toBe(code);
    }
    const del = await admin({ method: "DELETE", url: "/api/v1/admin/extensions/object-store-s3" });
    expect(del.statusCode).toBe(409);
  });

  it("安装（新装为停用）→ 批准 → 启用：工具可用；停用：撤销；全程不重启", async () => {
    const r = await install("life", v1);
    expect(r.view).toMatchObject({
      name: "life",
      source: "install",
      version: "1.0.0",
      desired: { version: "1.0.0", sha256: sha(v1), state: "disabled" },
      status: "pending_approval",
    });
    expect((await audits("extension.installed", "life"))[0]?.detail).toEqual({
      name: "life",
      version: "1.0.0",
      sha256: sha(v1),
      catalogItemId: null,
    });
    await approve("life");
    expect((await view("life")).status).toBe("disabled");
    expect(loadedVersion("life")).toBeUndefined();

    await setState("life", "enable");
    await waitFor(async () => loadedVersion("life") === "1.0.0", 15_000, "life 1.0.0 loaded");
    expect((await callTool("life")).content[0]?.text).toBe("life 1.0.0 done");
    await waitFor(async () => (await view("life")).status === "enabled", 10_000, "enabled");
    expect((await audits("extension.enabled", "life")).length).toBe(1);

    await setState("life", "disable");
    await waitFor(async () => loadedVersion("life") === undefined, 15_000, "life unloaded");
    expect(k.host.tools().some((t) => t.plugin === "life")).toBe(false);
    await waitFor(async () => (await view("life")).status === "disabled", 10_000, "disabled");
    expect((await audits("extension.disabled", "life")).length).toBe(1);
  });

  it("升级 v1 → v2：新权限待批准时 v1 照常；批准后迁移、切到 v2；在途的 v1 调用先结束，v1 再撤销", async () => {
    await setState("life", "enable");
    await waitFor(async () => loadedVersion("life") === "1.0.0", 15_000, "life 1.0.0 back");

    v2 = await lifePkg({ version: "2.0.0", migrations: [NOTES] });
    const r = await install("life", v2);
    expect(r.view.desired).toMatchObject({ version: "2.0.0", state: "enabled" });
    // v2 多了表权限：待批准，v1 照常
    await waitFor(
      async () => (await view("life")).status === "pending_approval",
      10_000,
      "v2 pending approval",
    );
    // 本副本已判定 v2 待批准（reconcile 跑过）；v2 的模块（含顶层代码）在批准之前没被导入
    await waitFor(
      async () =>
        (await view("life")).replicas.some(
          (r) => r.version === "2.0.0" && r.state === "pending" && r.reason === "approval",
        ),
      10_000,
      "replica reports v2 pending approval",
    );
    expect(g.__lifeImports ?? []).not.toContain("life 2.0.0");
    expect(loadedVersion("life")).toBe("1.0.0");
    // 状态行同时记下本副本仍在用的旧版本
    expect((await view("life")).replicas).toEqual([
      expect.objectContaining({ version: "2.0.0", state: "pending", servingVersion: "1.0.0" }),
    ]);

    // v1 有一个在途调用
    let release: () => void = () => {};
    g.__lifeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = k.host.current("life") as ExtensionInstance;
    const inflight = callTool("life");
    await waitFor(async () => old.inflight.size === 1, 5_000, "v1 call in flight");

    await approve("life");
    await waitFor(async () => loadedVersion("life") === "2.0.0", 15_000, "life 2.0.0 loaded");
    expect(g.__lifeImports).toContain("life 2.0.0");
    // 新调用走 v2；v1 还在排空
    expect(old.disposed).toBe(true);
    expect(old.inflight.size).toBe(1);
    expect(old.registrations().length).toBeGreaterThan(0);
    release();
    expect((await inflight).content[0]?.text).toBe("life 1.0.0 done");
    await waitFor(async () => old.registrations().length === 0, 5_000, "v1 disposed");
    delete g.__lifeGate;
    expect((await callTool("life")).content[0]?.text).toBe("life 2.0.0 done");

    // 迁移执行过一次、migrated_sha 记下
    const row = await db
      .selectFrom("extension_installs")
      .select("migrated_sha")
      .where("name", "=", "life")
      .executeTakeFirstOrThrow();
    expect(row.migrated_sha).toBe(sha(v2));
    const notes = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM plugin_life.notes`.execute(db);
    expect(notes.rows[0]?.n).toBe(1);
    await waitFor(async () => (await view("life")).status === "enabled", 10_000, "v2 enabled");
  });

  it("downgrade: the target version has unrun migrations -> 409 extension.downgrade_unsupported; migrations are a subset already run -> allowed", async () => {
    const bad = await lifePkg({
      version: "1.5.0",
      migrations: [NOTES, { file: "0002_extra.sql", sql: "SELECT 1;" }],
    });
    const r = await upload(bad);
    const res = await post("life/install", { sha256: r.sha256 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("extension.downgrade_unsupported");
    expect((await view("life")).desired?.version).toBe("2.0.0");

    // 回到 v1（没有迁移文件：是已执行迁移的子集），权限变少 → 不需批准，直接切换
    const back = await post("life/install", { sha256: sha(v1) });
    expect(back.statusCode, back.body).toBe(200);
    await waitFor(async () => loadedVersion("life") === "1.0.0", 15_000, "back to 1.0.0");
    // 再升回 v2（迁移已执行过，不重复执行）
    const up = await post("life/install", { sha256: sha(v2) });
    expect(up.statusCode, up.body).toBe(200);
    await waitFor(async () => loadedVersion("life") === "2.0.0", 15_000, "2.0.0 again");
    const notes = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM plugin_life.notes`.execute(db);
    expect(notes.rows[0]?.n).toBe(1);
  });

  it("依赖联动：提供方升级后依赖方 reload；提供方停用后依赖方卸下（dependency），回来后恢复", async () => {
    await install(
      "prov",
      await lifePkg({ name: "prov", version: "1.0.0", provides: ["counter@1"] }),
    );
    await install("dep", await lifePkg({ name: "dep", version: "1.0.0", requires: ["counter@1"] }));
    await approve("prov");
    await approve("dep");
    await setState("prov", "enable");
    await setState("dep", "enable");
    await waitFor(
      async () => loadedVersion("prov") === "1.0.0" && loadedVersion("dep") === "1.0.0",
      15_000,
      "prov + dep loaded",
    );
    const depSetups = () => g.__lifeSetups?.dep?.length ?? 0;
    const before = depSetups();

    await install(
      "prov",
      await lifePkg({ name: "prov", version: "1.1.0", provides: ["counter@1"] }),
    );
    await waitFor(async () => loadedVersion("prov") === "1.1.0", 15_000, "prov 1.1.0");
    await waitFor(async () => depSetups() === before + 1, 10_000, "dep reloaded once");
    expect(loadedVersion("dep")).toBe("1.0.0");

    await setState("prov", "disable");
    await waitFor(async () => loadedVersion("dep") === undefined, 15_000, "dep unloaded");
    await waitFor(async () => (await view("dep")).status === "dependency", 10_000, "dependency");
    const depRow = (await view("dep")).replicas[0];
    // 刚卸下时为 unloaded / dependency；之后的 reconcile 判定为 pending / dependency（提供方停用了）
    expect(depRow?.reason).toBe("dependency");
    expect(["unloaded", "pending"]).toContain(depRow?.state);

    await setState("prov", "enable");
    await waitFor(async () => loadedVersion("dep") === "1.0.0", 15_000, "dep back");
    await waitFor(async () => (await view("dep")).status === "enabled", 10_000, "dep enabled");
  });

  it("审阅：迁移里的破坏性语句列为敏感警告（不拒绝）", async () => {
    const r = (await upload(
      await lifePkg({
        name: "wreck",
        version: "1.0.0",
        migrations: [
          {
            file: "0001_wreck.sql",
            sql: "CREATE TABLE IF NOT EXISTS keep (id int);\nDROP TABLE IF EXISTS old_stuff;\nALTER TABLE keep DROP COLUMN IF EXISTS gone;\nDO $$ BEGIN EXECUTE 'DROP TABLE keep'; END $$;\n",
          },
        ],
      }),
    )) as unknown as { warnings: unknown[] };
    expect(r.warnings).toEqual([
      {
        kind: "destructive_migration",
        sensitive: true,
        file: "0001_wreck.sql",
        line: 2,
        statement: "DROP TABLE IF EXISTS old_stuff",
      },
      {
        kind: "destructive_migration",
        sensitive: true,
        file: "0001_wreck.sql",
        line: 3,
        statement: "ALTER TABLE keep DROP COLUMN IF EXISTS gone",
      },
      // DO 块的内容不做静态检查：整块标为 dynamic_sql
      {
        kind: "dynamic_sql",
        sensitive: true,
        file: "0001_wreck.sql",
        line: 4,
        statement: "DO $$",
      },
    ]);
    expect(
      (
        (await upload(await lifePkg({ name: "calm", version: "1.0.0" }))) as unknown as {
          warnings: unknown[];
        }
      ).warnings,
    ).toEqual([]);
  });

  it("提供方调用（connector）计入提供方实例的在途计数：停用时排空到会话关闭才撤销", async () => {
    await install(
      "conn",
      await lifePkg({ name: "conn", version: "1.0.0", provides: ["connector@1"] }),
    );
    await approve("conn");
    await setState("conn", "enable");
    await waitFor(async () => loadedVersion("conn") === "1.0.0", 15_000, "conn loaded");
    const inst = k.host.current("conn") as ExtensionInstance;
    const entry = k.host.list("connector").find((e) => e.plugin === "conn");
    expect(entry?.inflight).toBe(inst.inflight);
    type Session = { callTool(): Promise<{ content: { text: string }[] }>; close(): Promise<void> };
    const impl = entry?.impl as { kind: string; open(): Promise<Session> };
    expect(impl.kind).toBe("conn");

    let release: () => void = () => {};
    g.__lifeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = impl.open();
    expect(inst.inflight.size).toBe(1);
    await setState("conn", "disable");
    await waitFor(async () => loadedVersion("conn") === undefined, 15_000, "conn off the registry");
    // 排空中：实例已摘下，但登记还在（等会话关闭）
    await new Promise((r) => setTimeout(r, 300));
    expect(inst.registrations().length).toBeGreaterThan(0);
    release();
    delete g.__lifeGate;
    const session = await opening;
    expect((await session.callTool()).content[0]?.text).toBe("conn 1.0.0");
    expect(inst.inflight.size).toBe(1);
    await session.close();
    await waitFor(
      async () => inst.registrations().length === 0,
      5_000,
      "conn disposed after close",
    );
    await waitFor(async () => (await view("conn")).status === "disabled", 10_000, "conn disabled");
  });

  it("reconcile 刷新本副本状态行的心跳", async () => {
    const hb = async () =>
      (
        await db
          .selectFrom("extension_replica_status")
          .select("heartbeat_at")
          .where("plugin", "=", "life")
          .executeTakeFirstOrThrow()
      ).heartbeat_at.getTime();
    const before = await hb();
    await new Promise((r) => setTimeout(r, 20));
    await k.bus.publish("plugins.reconcile", {});
    await waitFor(async () => (await hb()) > before, 10_000, "heartbeat refreshed");
  });

  it("卸载须先停用；卸载后安装记录没了、数据（schema / 快照 / 组织配置）保留；路由闸门立即回到 404", async () => {
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/life`,
      payload: { enabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);

    const early = await admin({ method: "DELETE", url: "/api/v1/admin/extensions/life" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("extension.not_disabled");

    await setState("life", "disable");
    await waitFor(async () => loadedVersion("life") === undefined, 15_000, "life unloaded");
    // 组织页：部署上停用 → 不可用，组织的启用开关保留；不能在组织里改
    const orgList = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(orgList.statusCode, orgList.body).toBe(200);
    expect(
      (orgList.json().extensions as { plugin: string }[]).find((p) => p.plugin === "life"),
    ).toMatchObject({ plugin: "life", version: "2.0.0", enabled: true, available: false });
    const orgPut = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/life`,
      payload: { enabled: false },
    });
    expect(orgPut.statusCode).toBe(404);
    // 停用的插件属于本部署：路由 503（同时让闸门缓存住安装记录名）
    const gated = await admin({ method: "GET", url: "/plugins/life/anything" });
    expect(gated.statusCode).toBe(503);

    const del = await admin({ method: "DELETE", url: "/api/v1/admin/extensions/life" });
    expect(del.statusCode, del.body).toBe(204);
    expect((await audits("extension.uninstalled", "life"))[0]?.detail).toEqual({
      name: "life",
      version: "2.0.0",
      sha256: sha(v2),
    });
    // 收到 plugins.changed 时作废闸门缓存（不等 5s TTL）
    await waitFor(
      async () =>
        (await admin({ method: "GET", url: "/plugins/life/anything" })).statusCode === 404,
      2_000,
      "route gate 404",
      50,
    );
    expect(
      await db.selectFrom("extension_installs").select("name").where("name", "=", "life").execute(),
    ).toEqual([]);
    const notes = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM plugin_life.notes`.execute(db);
    expect(notes.rows[0]?.n).toBe(1);
    expect(
      await db
        .selectFrom("extension_permission_snapshots")
        .select("plugin")
        .where("plugin", "=", "life")
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom("extension_org_configs")
        .select("enabled")
        .where("plugin", "=", "life")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([{ enabled: true }]);
    const gone = await admin({ method: "GET", url: "/api/v1/admin/extensions/life" });
    expect(gone.statusCode).toBe(404);
    // Ruling P3：名字仍归原来的 npm 包（数据、密钥、批准都还在），别的包不能接手；原来的包可以重新安装
    const usurper = await upload(
      await lifePkg({ version: "3.0.0", packageName: "@evil/plugin-life" }),
    );
    const taken = await post("life/install", { sha256: usurper.sha256 });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.json().error.code).toBe("extension.name_conflict");
    expect(taken.json().error.message).toMatch(
      /previously used by package @test\/plugin-life; its data, secrets and permission approval are retained/,
    );
    expect(
      await db.selectFrom("extension_installs").select("name").where("name", "=", "life").execute(),
    ).toEqual([]);
    // 只上传、从没安装过的包不占名字
    await upload(
      await lifePkg({ name: "fresh", version: "1.0.0", packageName: "@other/plugin-fresh" }),
    );
    const fresh = await install("fresh", await lifePkg({ name: "fresh", version: "1.0.0" }));
    expect(fresh.view.desired?.state).toBe("disabled");
    // 卸载后可以从同一个包重新安装（数据还在：迁移已执行，不重复）
    await install("life", v2);
    expect((await view("life")).status).toBe("disabled");
  });

  it("Ruling P4：权限不变、迁移里多了 foreign_schema 语句的升级 → 待批准（旧版照常）；批准后加载", async () => {
    const TBL = { file: "0001_t.sql", sql: "CREATE TABLE IF NOT EXISTS t (id int);\n" };
    await install("warned", await lifePkg({ name: "warned", version: "1.0.0", migrations: [TBL] }));
    await approve("warned");
    await setState("warned", "enable");
    await waitFor(async () => loadedVersion("warned") === "1.0.0", 15_000, "warned 1.0.0");
    const grant = {
      file: "0002_grant.sql",
      sql: "GRANT SELECT ON plugin_warned.t TO PUBLIC;\n",
    };
    const r = await install(
      "warned",
      await lifePkg({ name: "warned", version: "1.1.0", migrations: [TBL, grant] }),
    );
    expect(r.view.added).toEqual([expect.stringMatching(/^migration\.warnings:[0-9a-f]{16}$/)]);
    expect(r.view.status).toBe("pending_approval");
    await waitFor(
      async () =>
        (await view("warned")).replicas.some(
          (x) => x.version === "1.1.0" && x.state === "pending" && x.reason === "approval",
        ),
      10_000,
      "1.1.0 pending approval",
    );
    expect(loadedVersion("warned")).toBe("1.0.0");
    await approve("warned");
    await waitFor(async () => loadedVersion("warned") === "1.1.0", 15_000, "warned 1.1.0");
    const snap = await db
      .selectFrom("extension_permission_snapshots")
      .select(["version", "permissions"])
      .where("plugin", "=", "warned")
      .executeTakeFirstOrThrow();
    expect(snap.version).toBe("1.1.0");
    expect((snap.permissions as { warningsDigest?: string }).warningsDigest).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });
});

describe("policy hooks across upgrade and disable (M-1, N-2)", { timeout: 90_000 }, () => {
  const run = (input: Record<string, unknown>) =>
    k.host.hooks.run(
      "tool.preExecute",
      {
        orgId,
        accountId: "acc-1",
        agentId: "agent-1",
        agentVersion: 1,
        conversationId: "conv-1",
        runId: "run-1",
        step: 1,
        callId: "call-1",
        toolKey: "x__y",
        specHash: "h",
        input,
      },
      new AbortController().signal,
    );
  const gate = () => {
    let release: () => void = () => {};
    g.__lifeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };

  it("an upgrade leaves no unguarded or fail-closed window; a disable's drain does not fail calls closed", async () => {
    await install("guard", await lifePkg({ name: "guard", version: "1.0.0", policy: true }));
    await approve("guard");
    await setState("guard", "enable");
    await waitFor(async () => loadedVersion("guard") === "1.0.0", 15_000, "guard 1.0.0 loaded");
    const res = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/guard`,
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(k.host.expectedPolicy("tool.preExecute")).toEqual(["guard"]);
    expect(await run({ deny: true })).toMatchObject({ reason: "guard 1.0.0 denies" });

    // upgrade while a v1 policy call is in flight: every call in the window is decided by a loaded
    // generation (never "not loaded")
    let release = gate();
    const v1 = k.host.current("guard") as ExtensionInstance;
    const held = run({ hold: true, deny: true });
    await waitFor(async () => v1.inflight.size === 1, 5_000, "v1 policy call in flight");
    await install("guard", await lifePkg({ name: "guard", version: "2.0.0", policy: true }));
    const seen: unknown[] = [];
    while (loadedVersion("guard") !== "2.0.0") {
      seen.push(await run({ deny: true }));
      await new Promise((r) => setTimeout(r, 20));
    }
    seen.push(await run({ deny: true }));
    for (const o of seen) expect(o).toMatchObject({ allowed: false, cause: "deny" });
    expect(seen.at(-1)).toMatchObject({ reason: "guard 2.0.0 denies" });
    release();
    expect(await held).toMatchObject({ reason: "guard 1.0.0 denies" });

    // disable while a v2 policy call is in flight: during the drain the plugin is no longer
    // expected, so new calls are allowed (not denied as "not loaded", nothing sticky to record)
    release = gate();
    const v2 = k.host.current("guard") as ExtensionInstance;
    const held2 = run({ hold: true });
    await waitFor(async () => v2.inflight.size === 1, 5_000, "v2 policy call in flight");
    await setState("guard", "disable");
    await waitFor(async () => k.host.current("guard") === undefined, 15_000, "guard deactivated");
    expect(v2.inflight.size).toBe(1);
    expect(k.host.expectedPolicy("tool.preExecute")).toEqual([]);
    expect(await run({ deny: true })).toEqual({ allowed: true });
    release();
    expect(await held2).toEqual({ allowed: true });
    delete g.__lifeGate;
  });
});

describe("停机：后台排空中的旧实例在 lifecycleWaitMs 后强制撤销", { timeout: 60_000 }, () => {
  it("in-flight calls of the old instance after an upgrade do not finish: shutdown does not wait drainSeconds, the call ends with ExtensionUnloadedError", async () => {
    await setState("life", "enable");
    await waitFor(async () => loadedVersion("life") === "2.0.0", 15_000, "life 2.0.0 loaded");
    g.__lifeGate = new Promise<void>(() => {});
    const old = k.host.current("life") as ExtensionInstance;
    const pending = callTool("life");
    pending.catch(() => {});
    await waitFor(async () => old.inflight.size === 1, 5_000, "call in flight");
    await install("life", await lifePkg({ version: "1.0.0" }));
    await waitFor(async () => loadedVersion("life") === "1.0.0", 15_000, "1.0.0 loaded");
    // activate 先换上新实例，写完状态才 retire 旧实例
    await waitFor(async () => old.disposed, 5_000, "old retiring");
    expect(old.disposed).toBe(true);
    expect(old.registrations().length).toBeGreaterThan(0);
    const started = Date.now();
    await k.stop();
    expect(Date.now() - started).toBeLessThan(15_000);
    // 停机返回时旧实例已撤销完：在途调用已中止（不等 30 秒的排空时限）
    expect(old.inflight.signal.aborted).toBe(true);
    expect(old.registrations()).toEqual([]);
    await expect(pending).rejects.toThrow(/unloaded/);
    delete g.__lifeGate;
  });
});

describe("启动中止：host.load 里进行中的插件迁移随停机中止", { timeout: 60_000 }, () => {
  it("迁移卡在 schema 锁上时 stop() 很快返回，start() 失败，锁随后可用", async () => {
    const pkgBytes = await lifePkg({
      name: "slowmig",
      version: "1.0.0",
      migrations: [{ file: "0001_a.sql", sql: "CREATE TABLE IF NOT EXISTS a (id int);\n" }],
    });
    const pkg = await readExtensionPackage(pkgBytes, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new ExtensionBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, pkgBytes, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db
      .insertInto("extension_installs")
      .values({
        name: "slowmig",
        sha256: pkg.sha256,
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    const holder = new pg.Client({ connectionString: pgc.url });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [
      "capybara-migrate:plugin_slowmig",
    ]);
    try {
      const k2 = await createKernel(
        runConfig(
          { pg: pgc.url, redis: rd.url },
          {
            roles: ["api"],
            extensions: [],
            extensionPermissions: { autoApprove: true },
            extensionHost: { dir: pluginsDir },
            packages: { maxBytes: MAX_BYTES },
          },
        ),
        { env: {}, logger: createLogger("error", { write: () => {} }) },
      );
      const starting = k2.start();
      starting.catch(() => {});
      await waitFor(
        async () =>
          (
            await sql<{
              n: number;
            }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(
              db,
            )
          ).rows[0]?.n === 1,
        20_000,
        "plugin migration waiting on the schema lock",
      );
      const t0 = Date.now();
      await k2.stop();
      expect(Date.now() - t0).toBeLessThan(10_000);
      await expect(starting).rejects.toThrow();
      expect(
        (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(
            db,
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

describe("安装记录不受信任：启动时的 setup 与迁移都限时（I3）", { timeout: 60_000 }, () => {
  /** 把包存进 PG 包存储并写一条期望启用的安装记录。 */
  const seedInstall = async (name: string, bytes: Uint8Array) => {
    const pkg = await readExtensionPackage(bytes, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new ExtensionBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, bytes, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db
      .insertInto("extension_installs")
      .values({
        name,
        sha256: pkg.sha256,
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
  };
  /** start() 在 `ms` 内返回 → started；否则 hung（不等它）。 */
  const startWithin = async (k2: Kernel, ms: number) => {
    const starting = k2.start();
    starting.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      starting.then(() => "started" as const),
      new Promise<"hung">((r) => {
        timer = setTimeout(() => r("hung"), ms);
      }),
    ]);
    clearTimeout(timer);
    return outcome;
  };
  const statusOf = (plugin: string) =>
    db
      .selectFrom("extension_replica_status")
      .select(["state", "reason", "detail"])
      .where("plugin", "=", plugin)
      .execute();
  const kernelWith = (extensionHost: Record<string, unknown>) =>
    createKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["api"],
          extensions: [],
          extensionPermissions: { autoApprove: true },
          extensionHost: { dir: pluginsDir, ...extensionHost },
          packages: { maxBytes: MAX_BYTES },
        },
      ),
      { env: {}, logger: createLogger("error", { write: () => {} }) },
    );

  it("安装记录的 setup 挂住：start() 照常返回，该插件记 failed / setup_failed", async () => {
    await seedInstall(
      "hangsetup",
      await pluginTgz({
        name: "hangsetup",
        entry: [
          'import { defineExtension } from "@capybara-hq/plugin-sdk";',
          'export default defineExtension({ name: "hangsetup", version: "1.0.0", sdk: "^0.1.0", provides: [], permissions: {}, setup() { return new Promise(() => {}); } });',
        ].join("\n"),
      }),
    );
    const k2 = await kernelWith({ reloadSetupTimeoutSeconds: 1 });
    try {
      expect(await startWithin(k2, 15_000)).toBe("started");
      expect(k2.host.current("hangsetup")).toBeUndefined();
      expect(await statusOf("hangsetup")).toEqual([
        expect.objectContaining({ state: "failed", reason: "setup_failed" }),
      ]);
    } finally {
      await k2.stop();
      await db.deleteFrom("extension_installs").where("name", "=", "hangsetup").execute();
    }
  });

  it("模块顶层代码挂住：导入同样限时，start() 照常返回，记 failed / import_failed", async () => {
    await seedInstall(
      "hangimport",
      await pluginTgz({
        name: "hangimport",
        entry: [
          'import { defineExtension } from "@capybara-hq/plugin-sdk";',
          "await new Promise(() => {});",
          'export default defineExtension({ name: "hangimport", version: "1.0.0", sdk: "^0.1.0", provides: [], permissions: {}, setup() {} });',
        ].join("\n"),
      }),
    );
    const k2 = await kernelWith({ reloadSetupTimeoutSeconds: 1 });
    try {
      expect(await startWithin(k2, 15_000)).toBe("started");
      expect(k2.host.current("hangimport")).toBeUndefined();
      const [row] = await statusOf("hangimport");
      expect(row).toMatchObject({ state: "failed", reason: "import_failed" });
      expect(row?.detail).toMatch(/importing its module did not finish within 1s/);
    } finally {
      await k2.stop();
      await db.deleteFrom("extension_installs").where("name", "=", "hangimport").execute();
    }
  });

  it("迁移挂住：extensionHost.migrationTimeoutSeconds 到时终止会话、记 migration_failed，锁随之释放", async () => {
    await seedInstall(
      "sleepmig",
      await lifePkg({
        name: "sleepmig",
        version: "1.0.0",
        migrations: [{ file: "0001_sleep.sql", sql: "SELECT pg_sleep(60);\n" }],
      }),
    );
    const k2 = await kernelWith({ migrationTimeoutSeconds: 1 });
    try {
      expect(await startWithin(k2, 20_000)).toBe("started");
      expect(k2.host.current("sleepmig")).toBeUndefined();
      const [row] = await statusOf("sleepmig");
      expect(row).toMatchObject({ state: "failed", reason: "migration_failed" });
      expect(row?.detail).toMatch(/did not finish within 1s/);
      // 迁移锁与按 schema 的锁都已释放
      const probe = new pg.Client({ connectionString: pgc.url });
      await probe.connect();
      try {
        for (const key of [
          "capybara.plugin-migrate:sleepmig",
          "capybara-migrate:plugin_sleepmig",
        ]) {
          const r = await probe.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [key]);
          expect(r.rows[0]?.ok, key).toBe(true);
          await probe.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
        }
      } finally {
        await probe.end();
      }
      // 迁移会话已终止
      await waitFor(
        async () =>
          (
            await sql<{
              n: number;
            }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%' AND datname = current_database()`.execute(
              db,
            )
          ).rows[0]?.n === 0,
        5_000,
        "migration backend terminated",
      );
      const migrated = await db
        .selectFrom("extension_installs")
        .select("migrated_sha")
        .where("name", "=", "sleepmig")
        .executeTakeFirstOrThrow();
      expect(migrated.migrated_sha).toBeNull();
    } finally {
      await k2.stop();
      await db.deleteFrom("extension_installs").where("name", "=", "sleepmig").execute();
    }
  });
});

describe("插件名归属：内置与配置声明的插件也占名字（I4）", { timeout: 60_000 }, () => {
  it("配置声明的插件从 plugins 去掉后，别的包不能用同名插件安装；无归属但有遗留数据的名字同样拒绝", async () => {
    // 第一个内核启动时（extensions: [MODEL_FAKE]，内置 object-store-s3）已登记归属
    const owners = await db
      .selectFrom("extension_name_owners")
      .select(["name", "package_name"])
      .where("name", "in", ["model-fake", "object-store-s3"])
      .orderBy("name")
      .execute();
    expect(owners).toEqual([
      { name: "model-fake", package_name: "@capybara-hq/plugin-model-fake" },
      { name: "object-store-s3", package_name: "@capybara-hq/plugin-object-store-s3" },
    ]);
    // 重启后 model-fake 不再在配置列表里
    const k3 = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["api"],
          extensions: [],
          extensionPermissions: { autoApprove: false },
          extensionHost: { dir: pluginsDir, reconcileIntervalSeconds: 3600 },
          packages: { maxBytes: MAX_BYTES },
        },
      ),
    );
    try {
      const root = await session(k3, "root");
      const tryInstall = async (bytes: Uint8Array, name: string) => {
        const up = await root({
          method: "POST",
          url: "/api/v1/admin/extensions/packages/file",
          headers: { "content-type": "application/octet-stream" },
          payload: Buffer.from(bytes),
        });
        expect(up.statusCode, up.body).toBe(200);
        return root({
          method: "POST",
          url: `/api/v1/admin/extensions/${name}/install`,
          payload: { sha256: (up.json() as { sha256: string }).sha256 },
        });
      };
      const taken = await tryInstall(
        await lifePkg({ name: "model-fake", version: "9.0.0", packageName: "@evil/model-fake" }),
        "model-fake",
      );
      expect(taken.statusCode, taken.body).toBe(409);
      expect(taken.json().error.code).toBe("extension.name_conflict");
      expect(taken.json().error.message).toMatch(
        /previously used by package @capybara-hq\/plugin-model-fake/,
      );

      // 名字没有归属，但已有部署配置留下（归属表之前的数据）：不知道属于哪个包，拒绝
      await db
        .insertInto("extension_deployment_configs")
        .values({ plugin: "ghost", config: JSON.stringify({ dir: "" }) })
        .execute();
      const ghost = await tryInstall(await lifePkg({ name: "ghost", version: "1.0.0" }), "ghost");
      expect(ghost.statusCode, ghost.body).toBe(409);
      expect(ghost.json().error.code).toBe("extension.name_conflict");
      expect(ghost.json().error.message).toMatch(/retained data/);
      expect(
        await db
          .selectFrom("extension_name_owners")
          .select("name")
          .where("name", "=", "ghost")
          .execute(),
      ).toEqual([]);
    } finally {
      await k3.stop();
    }
  });
});

describe("停机：本副本的状态行删除（I6）", { timeout: 90_000 }, () => {
  it("两个副本都加载了插件；一个正常停机后状态立即为 enabled（不等心跳过期）", async () => {
    const bytes = await pluginTgz({ name: "twin", version: "1.0.0" });
    const pkg = await readExtensionPackage(bytes, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new ExtensionBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, bytes, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db
      .insertInto("extension_installs")
      .values({
        name: "twin",
        sha256: pkg.sha256,
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    const cfg = runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [],
        extensionPermissions: { autoApprove: true },
        extensionHost: { dir: pluginsDir, reconcileIntervalSeconds: 3600 },
        packages: { maxBytes: MAX_BYTES },
      },
    );
    const a = await startKernel(cfg);
    let b: Kernel | undefined = await startKernel(cfg);
    const aId = a.replicaId;
    const bId = b.replicaId;
    try {
      const root = await session(a, "root");
      const status = async () => {
        const res = await root({ method: "GET", url: "/api/v1/admin/extensions/twin" });
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as View;
      };
      await waitFor(
        async () => {
          const s = await status();
          return (
            s.replicas.some((r) => r.replicaId === aId) &&
            s.replicas.some((r) => r.replicaId === bId)
          );
        },
        15_000,
        "both replicas loaded twin",
      );
      const before = await status();
      expect(before.status).toBe("enabled");
      expect(before.replicas.every((r) => r.state === "loaded")).toBe(true);
      await b.stop();
      b = undefined;
      const after = await status();
      expect(after.replicas.map((r) => r.replicaId)).not.toContain(bId);
      expect(after.replicas).toHaveLength(before.replicas.length - 1);
      expect(after.status).toBe("enabled");
    } finally {
      await b?.stop();
      await a.stop();
      await db.deleteFrom("extension_installs").where("name", "=", "twin").execute();
    }
  });
});

describe("副本状态行的 detail 写入前打码（M2）", () => {
  it("write / note 的 detail 经 redact 处理", async () => {
    const log = createLogger("error", { write: () => {} });
    log.addSecrets(["sup3r-s3cret-token"]);
    const store = new ReplicaStatusStore(db, "redact-test-replica", undefined, (t) =>
      log.redact(t),
    );
    try {
      await store.write({
        plugin: "leaky",
        version: "1.0.0",
        sha256: null,
        source: "config",
        state: "failed",
        reason: "setup_failed",
        detail: "login with sup3r-s3cret-token failed",
      });
      const read = () =>
        db
          .selectFrom("extension_replica_status")
          .select("detail")
          .where("replica_id", "=", "redact-test-replica")
          .executeTakeFirstOrThrow();
      expect((await read()).detail).toBe("login with [REDACTED] failed");
      await store.note("leaky", "retry sup3r-s3cret-token later");
      expect((await read()).detail).toBe("retry [REDACTED] later");
    } finally {
      await store.removeAll();
    }
  });
});
