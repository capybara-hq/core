import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolHandler } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import type { PluginInstance } from "../../src/plugins/instance.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { lifePkg } from "../helpers/plugin-packages.js";
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
  replicas: { replicaId: string; state: string; reason: string | null; version: string }[];
  reviewHash: string;
}

const g = globalThis as { __lifeGate?: Promise<void>; __lifeSetups?: Record<string, string[]> };

const upload = async (bytes: Uint8Array) => {
  const res = await admin({
    method: "POST",
    url: "/api/v1/admin/plugins/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { sha256: string; reviewHash: string; name: string };
};
const post = (path: string, payload?: Record<string, unknown>) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/plugins/${path}`,
    ...(payload !== undefined && { payload }),
  });
const view = async (name: string) => {
  const res = await admin({ method: "GET", url: `/api/v1/admin/plugins/${name}` });
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
    "capybara.plugin_replica_status, capybara.plugin_installs, capybara.plugin_blobs, capybara.plugin_packages, capybara.plugin_permission_snapshots, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        plugins: [MODEL_FAKE],
        pluginPermissions: { autoApprove: false },
        pluginHost: { dir: pluginsDir, drainSeconds: 30, reconcileIntervalSeconds: 3600 },
        packages: { maxBytes: MAX_BYTES },
      },
    ),
    { builtinPlugins: [S3_PLUGIN] },
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
      ["object-store-s3/install", { sha256: r.sha256 }, 409, "plugin.builtin"],
      ["model-fake/install", { sha256: r.sha256 }, 409, "plugin.config_declared"],
      ["life/install", { sha256: "0".repeat(64) }, 404, "plugin.package_not_found"],
      ["other/install", { sha256: r.sha256 }, 409, "plugin.name_mismatch"],
      ["life/install", { sha256: "nothex" }, 400, "validation_failed"],
      ["nope/enable", undefined, 404, "plugin.not_found"],
      ["object-store-s3/disable", undefined, 409, "plugin.builtin"],
      ["model-fake/disable", undefined, 409, "plugin.config_declared"],
    ];
    for (const [path, body, status, code] of cases) {
      const res = await post(path, body);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(status);
      expect(res.json().error.code, path).toBe(code);
    }
    const del = await admin({ method: "DELETE", url: "/api/v1/admin/plugins/object-store-s3" });
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
    expect((await audits("plugin.installed", "life"))[0]?.detail).toEqual({
      name: "life",
      version: "1.0.0",
      sha256: sha(v1),
    });
    await approve("life");
    expect((await view("life")).status).toBe("disabled");
    expect(loadedVersion("life")).toBeUndefined();

    await setState("life", "enable");
    await waitFor(async () => loadedVersion("life") === "1.0.0", 15_000, "life 1.0.0 loaded");
    expect((await callTool("life")).content[0]?.text).toBe("life 1.0.0 done");
    await waitFor(async () => (await view("life")).status === "enabled", 10_000, "enabled");
    expect((await audits("plugin.enabled", "life")).length).toBe(1);

    await setState("life", "disable");
    await waitFor(async () => loadedVersion("life") === undefined, 15_000, "life unloaded");
    expect(k.host.tools().some((t) => t.plugin === "life")).toBe(false);
    await waitFor(async () => (await view("life")).status === "disabled", 10_000, "disabled");
    expect((await audits("plugin.disabled", "life")).length).toBe(1);
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
    expect(loadedVersion("life")).toBe("1.0.0");

    // v1 有一个在途调用
    let release: () => void = () => {};
    g.__lifeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = k.host.current("life") as PluginInstance;
    const inflight = callTool("life");
    await waitFor(async () => old.inflight.size === 1, 5_000, "v1 call in flight");

    await approve("life");
    await waitFor(async () => loadedVersion("life") === "2.0.0", 15_000, "life 2.0.0 loaded");
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
      .selectFrom("plugin_installs")
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

  it("降级：目标版本有未执行的迁移 → 409 plugin.downgrade_unsupported；迁移是已执行的子集 → 允许", async () => {
    const bad = await lifePkg({
      version: "1.5.0",
      migrations: [NOTES, { file: "0002_extra.sql", sql: "SELECT 1;" }],
    });
    const r = await upload(bad);
    const res = await post("life/install", { sha256: r.sha256 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("plugin.downgrade_unsupported");
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

  it("提供方调用（connector）计入提供方实例的在途计数：停用时排空到会话关闭才撤销", async () => {
    await install(
      "conn",
      await lifePkg({ name: "conn", version: "1.0.0", provides: ["connector@1"] }),
    );
    await approve("conn");
    await setState("conn", "enable");
    await waitFor(async () => loadedVersion("conn") === "1.0.0", 15_000, "conn loaded");
    const inst = k.host.current("conn") as PluginInstance;
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
          .selectFrom("plugin_replica_status")
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
      url: `/api/v1/orgs/${orgId}/plugins/life`,
      payload: { enabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);

    const early = await admin({ method: "DELETE", url: "/api/v1/admin/plugins/life" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("plugin.not_disabled");

    await setState("life", "disable");
    await waitFor(async () => loadedVersion("life") === undefined, 15_000, "life unloaded");
    // 组织页：部署上停用 → 不可用，组织的启用开关保留；不能在组织里改
    const orgList = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/plugins` });
    expect(orgList.statusCode, orgList.body).toBe(200);
    expect(
      (orgList.json().plugins as { plugin: string }[]).find((p) => p.plugin === "life"),
    ).toMatchObject({ plugin: "life", version: "2.0.0", enabled: true, available: false });
    const orgPut = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/life`,
      payload: { enabled: false },
    });
    expect(orgPut.statusCode).toBe(404);
    // 停用的插件属于本部署：路由 503（同时让闸门缓存住安装记录名）
    const gated = await admin({ method: "GET", url: "/plugins/life/anything" });
    expect(gated.statusCode).toBe(503);

    const del = await admin({ method: "DELETE", url: "/api/v1/admin/plugins/life" });
    expect(del.statusCode, del.body).toBe(204);
    expect((await audits("plugin.uninstalled", "life"))[0]?.detail).toEqual({
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
      await db.selectFrom("plugin_installs").select("name").where("name", "=", "life").execute(),
    ).toEqual([]);
    const notes = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM plugin_life.notes`.execute(db);
    expect(notes.rows[0]?.n).toBe(1);
    expect(
      await db
        .selectFrom("plugin_permission_snapshots")
        .select("plugin")
        .where("plugin", "=", "life")
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom("plugin_org_configs")
        .select("enabled")
        .where("plugin", "=", "life")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([{ enabled: true }]);
    const gone = await admin({ method: "GET", url: "/api/v1/admin/plugins/life" });
    expect(gone.statusCode).toBe(404);
    // 卸载后可以重新安装（数据还在：迁移已执行，不重复）
    await install("life", v2);
    expect((await view("life")).status).toBe("disabled");
  });
});
