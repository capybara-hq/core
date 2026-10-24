import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { PLUGINS_CHANGED_TOPIC } from "../../src/extensions/admin-view.js";
import { ExtensionBlobs } from "../../src/extensions/blobs.js";
import { permissionSetOfPackage, readExtensionPackage } from "../../src/extensions/package.js";
import { reviewHash } from "../../src/extensions/permission-view.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session, startKernel, waitFor } from "../helpers/runs.js";

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const PERM_A = fixture("perm-a");
const PERM_DEP = fixture("perm-dep");
const SANDBOX_FAKE = fixture("sandbox-fake");

const MAX_BYTES = 4 * 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let member: Req;
let adminId: string;
let demo: Uint8Array;
let demoHash: string;

interface View {
  name: string;
  version: string;
  source: string;
  sha256: string | null;
  status: string;
  desired: { version: string; sha256: string; state: string } | null;
  replicas: { replicaId: string; state: string; reason: string | null }[];
  permissions: { category: string; sensitive: boolean; items: string[] }[];
  added: string[];
  removed: string[];
  reviewHash: string;
  sensitive: boolean;
  snapshot: {
    version: string;
    approvedAt: string;
    approvedBy: string | null;
    source: string;
  } | null;
  configurable: boolean;
  configValid: boolean;
  removable: boolean;
}

async function installPkg(
  name: string,
  bytes: Uint8Array,
  state: "enabled" | "disabled",
): Promise<void> {
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
    .values({ name, sha256: sha(bytes), version: "1.0.0", source: "file", desired_state: state })
    .execute();
}

const list = async (req: Req = admin) => {
  const res = await req({ method: "GET", url: "/api/v1/admin/plugins" });
  expect(res.statusCode, res.body).toBe(200);
  return new Map((res.json().plugins as View[]).map((p) => [p.name, p]));
};
const approve = (name: string, body: Record<string, unknown>, req: Req = admin) =>
  req({ method: "POST", url: `/api/v1/admin/plugins/${name}/approve`, payload: body });
const snapshotOf = (plugin: string) =>
  db
    .selectFrom("extension_permission_snapshots")
    .selectAll()
    .where("plugin", "=", plugin)
    .executeTakeFirst();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-plugins-"));
  await truncateTables(
    db,
    "capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  demo = await pluginTgz({ name: "demo-pkg" });
  demoHash = sha(demo);
  await installPkg("demo-pkg", demo, "enabled");
  await installPkg("demo-off", await pluginTgz({ name: "demo-off" }), "disabled");
  await installPkg("demo-late", await pluginTgz({ name: "demo-late" }), "enabled");
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        plugins: [MODEL_FAKE, PERM_A, PERM_DEP, SANDBOX_FAKE],
        pluginPermissions: { autoApprove: false },
        pluginHost: { dir: pluginsDir },
        packages: { maxBytes: MAX_BYTES },
      },
    ),
    { builtinExtensions: [S3_PLUGIN] },
  );
  const accounts = new AccountsService(db);
  adminId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    })
  ).id;
  await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
  admin = await session(k, "root");
  member = await session(k, "mem");
}, 240_000);
afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("插件列表与网页批准权限", () => {
  it("非企业管理员：列表、详情与批准都 403", async () => {
    for (const res of [
      await member({ method: "GET", url: "/api/v1/admin/plugins" }),
      await member({ method: "GET", url: "/api/v1/admin/plugins/demo-pkg" }),
      await approve("demo-pkg", { sha256: demoHash, reviewHash: "0".repeat(16) }, member),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
  });

  it("列表带 drainSeconds（停用 / 升级时界面提示在途调用最多等多久）", async () => {
    const res = await admin({ method: "GET", url: "/api/v1/admin/plugins" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().drainSeconds).toBe(30);
  });

  it("列表：内置 / 配置声明 / 安装记录三种来源；提供 sandbox@1 / object-store@1 的标敏感", async () => {
    const all = await list();
    expect([...all.keys()].sort()).toEqual(
      [
        "demo-late",
        "demo-off",
        "demo-pkg",
        "model-fake",
        "object-store-s3",
        "perm-a",
        "perm-dep",
        "sandbox-fake",
      ].sort(),
    );

    // 顶层 sensitive 与分组标记一致（界面据此高亮）
    for (const v of all.values()) {
      expect(v.sensitive, v.name).toBe(v.permissions.some((g) => g.sensitive));
    }
    const s3 = all.get("object-store-s3") as View;
    expect(s3).toMatchObject({
      source: "builtin",
      sha256: null,
      desired: null,
      status: "pending_config",
      sensitive: true,
      snapshot: null,
      added: [],
      removed: [],
      configurable: true,
      configValid: false,
      removable: false,
    });
    expect(s3.permissions.find((g) => g.category === "provides")).toEqual({
      category: "provides",
      sensitive: true,
      items: ["object-store@1"],
      entries: [{ value: "object-store@1", sensitive: true, reason: "object_store" }],
    });
    expect((s3 as View & { warnings: unknown[] }).warnings).toEqual([]);

    const sandbox = all.get("sandbox-fake") as View;
    expect(sandbox).toMatchObject({
      source: "config",
      status: "pending_approval",
      sensitive: true,
      removable: false,
    });
    expect(sandbox.permissions.find((g) => g.category === "provides")?.sensitive).toBe(true);
    expect(sandbox.added).toContain("provides:sandbox@1");
    // added 逐项带敏感标记与原因码：界面只渲染，不自己判定
    const addedItems = (sandbox as View & { addedItems: unknown[] }).addedItems;
    expect(addedItems).toHaveLength(sandbox.added.length);
    expect(addedItems).toContainEqual({
      value: "provides:sandbox@1",
      sensitive: true,
      reason: "sandbox",
    });

    expect(all.get("model-fake")).toMatchObject({
      source: "config",
      status: "pending_approval",
      sensitive: false,
    });

    const pkg = await readExtensionPackage(demo, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    const d = all.get("demo-pkg") as View;
    expect(d).toMatchObject({
      source: "install",
      version: "1.0.0",
      sha256: demoHash,
      desired: { version: "1.0.0", sha256: demoHash, state: "enabled" },
      status: "pending_approval",
      sensitive: false,
      snapshot: null,
      reviewHash: reviewHash(permissionSetOfPackage(pkg)),
      configurable: false,
      configValid: true,
      removable: true,
    });
    expect(d.replicas).toEqual([
      expect.objectContaining({ replicaId: k.replicaId, state: "pending", reason: "approval" }),
    ]);
    // 待批准与期望状态无关（F-N）：停用的安装记录同样待批准
    expect(all.get("demo-off")).toMatchObject({
      status: "pending_approval",
      desired: expect.objectContaining({ state: "disabled" }),
    });
  });

  it("详情：与列表一项相同；未知插件 404", async () => {
    const res = await admin({ method: "GET", url: "/api/v1/admin/plugins/demo-pkg" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual((await list()).get("demo-pkg"));
    const nope = await admin({ method: "GET", url: "/api/v1/admin/plugins/nope" });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error.code).toBe("extension.not_found");
  });

  it("builtin extensions are pre-approved: approving returns 409 extension.builtin; unknown extension 404", async () => {
    const s3 = (await list()).get("object-store-s3") as View;
    const res = await approve("object-store-s3", { sha256: null, reviewHash: s3.reviewHash });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("extension.builtin");
    const nope = await approve("nope", { sha256: null, reviewHash: "0".repeat(16) });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error.code).toBe("extension.not_found");
  });

  it("reviewHash or sha256 out of date -> 409 extension.approval_stale, no snapshot; a config-declared extension's sha256 must be null", async () => {
    const d = (await list()).get("demo-pkg") as View;
    const stale = await approve("demo-pkg", { sha256: demoHash, reviewHash: "0".repeat(16) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("extension.approval_stale");
    const otherPkg = await approve("demo-pkg", {
      sha256: "c".repeat(64),
      reviewHash: d.reviewHash,
    });
    expect(otherPkg.statusCode).toBe(409);
    expect(otherPkg.json().error.code).toBe("extension.approval_stale");
    const noSha = await approve("demo-pkg", { sha256: null, reviewHash: d.reviewHash });
    expect(noSha.statusCode).toBe(409);
    expect(noSha.json().error.code).toBe("extension.approval_stale");
    const m = (await list()).get("model-fake") as View;
    const withSha = await approve("model-fake", { sha256: demoHash, reviewHash: m.reviewHash });
    expect(withSha.statusCode).toBe(400);
    const bad = await approve("demo-pkg", { sha256: demoHash });
    expect(bad.statusCode).toBe(400);
    expect(await snapshotOf("demo-pkg")).toBeUndefined();
    expect(await snapshotOf("model-fake")).toBeUndefined();
  });

  it("approving an install record: snapshot source web, audit, kernel.plugins.changed published, this replica loads it; approving again 409 extension.not_pending", async () => {
    const got: unknown[] = [];
    const unsubscribe = await k.bus.subscribe(PLUGINS_CHANGED_TOPIC, (p) => {
      got.push(p);
    });
    try {
      const d = (await list()).get("demo-pkg") as View;
      expect(k.host.current("demo-pkg")).toBeUndefined();
      const res = await approve("demo-pkg", { sha256: demoHash, reviewHash: d.reviewHash });
      expect(res.statusCode, res.body).toBe(200);
      const view = res.json() as View;
      expect(view.snapshot).toMatchObject({ version: "1.0.0", approvedBy: adminId, source: "web" });
      expect(view.added).toEqual([]);
      expect(view.status).toBe("enabled");
      expect(await snapshotOf("demo-pkg")).toMatchObject({
        version: "1.0.0",
        source: "web",
        approved_by: adminId,
      });
      const audits = await db
        .selectFrom("audit_events")
        .select(["actor_account_id", "target", "detail"])
        .where("action", "=", "extension.permissions_approved")
        .execute();
      expect(audits).toEqual([
        {
          actor_account_id: adminId,
          target: "demo-pkg",
          detail: expect.objectContaining({
            plugin: "demo-pkg",
            version: "1.0.0",
            sha256: demoHash,
            source: "web",
            removed: [],
          }),
        },
      ]);
      await waitFor(async () => got.length > 0);
      expect(got).toEqual([{ plugin: "demo-pkg" }]);
      // 本副本：待批准的实例随即加载（跨副本收敛由 T14 的 reconcile 负责）
      expect(k.host.current("demo-pkg")?.sha256).toBe(demoHash);
      expect(k.host.pending().map((p) => p.plugin)).not.toContain("demo-pkg");
      const status = await db
        .selectFrom("extension_replica_status")
        .select(["state", "reason"])
        .where("plugin", "=", "demo-pkg")
        .executeTakeFirstOrThrow();
      expect(status).toEqual({ state: "loaded", reason: null });

      const again = await approve("demo-pkg", { sha256: demoHash, reviewHash: d.reviewHash });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("extension.not_pending");
    } finally {
      await unsubscribe();
    }
  });

  it("批准停用的安装记录：只写快照，本副本不加载；状态 disabled", async () => {
    const d = (await list()).get("demo-off") as View;
    const res = await approve("demo-off", { sha256: d.sha256, reviewHash: d.reviewHash });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "disabled", snapshot: { source: "web" } });
    expect(k.host.current("demo-off")).toBeUndefined();
  });

  it("启动后被停用的安装记录：批准只写快照，本副本不按启动时的待批准参数加载", async () => {
    await db
      .updateTable("extension_installs")
      .set({ desired_state: "disabled" })
      .where("name", "=", "demo-late")
      .execute();
    const d = (await list()).get("demo-late") as View;
    const res = await approve("demo-late", { sha256: d.sha256, reviewHash: d.reviewHash });
    expect(res.statusCode, res.body).toBe(200);
    expect(k.host.current("demo-late")).toBeUndefined();
    expect(await snapshotOf("demo-late")).toMatchObject({ source: "web" });
  });

  it("配置声明的插件（sha256 null）：依赖待批准时状态 dependency；批准提供方后两者都在本副本加载", async () => {
    const all = await list();
    const dep = all.get("perm-dep") as View;
    const r1 = await approve("perm-dep", { sha256: null, reviewHash: dep.reviewHash });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ status: "dependency", snapshot: { source: "web" } });
    expect(k.host.current("perm-dep")).toBeUndefined();

    const a = all.get("perm-a") as View;
    const r2 = await approve("perm-a", { sha256: null, reviewHash: a.reviewHash });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(k.host.current("perm-a")).toBeDefined();
    expect(k.host.current("perm-dep")).toBeDefined();
    const after = await list();
    expect(after.get("perm-a")?.status).toBe("enabled");
    expect(after.get("perm-dep")?.status).toBe("enabled");
    expect(after.get("sandbox-fake")?.status).toBe("pending_approval");
  });

  it("安装记录的迁移警告随视图返回（详情页批准前同样高亮）；内置 / 配置声明为空", async () => {
    const bytes = await pluginTgz({
      name: "demo-warn",
      section: { migrations: "migrations" },
      extra: [
        {
          name: "package/migrations/0001_init.sql",
          data: "CREATE TABLE IF NOT EXISTS plugin_demo_warn.notes (id int);\nDROP TABLE IF EXISTS plugin_demo_warn.old;\n",
        },
      ],
    });
    await installPkg("demo-warn", bytes, "disabled");
    const all = await list();
    const w = all.get("demo-warn") as View & { warnings: Record<string, unknown>[] };
    expect(w.warnings).toEqual([
      expect.objectContaining({
        kind: "destructive_migration",
        sensitive: true,
        file: "0001_init.sql",
        line: 2,
      }),
    ]);
    expect((all.get("model-fake") as View & { warnings: unknown[] }).warnings).toEqual([]);
    const one = await admin({ method: "GET", url: "/api/v1/admin/plugins/demo-warn" });
    expect(one.json().warnings).toEqual(w.warnings);
  });

  it("unreadable package (bytes missing): the list degrades to a failed item (no permissions, error names name, version and sha, uninstallable); details and approval return 409 extension.package_unavailable", async () => {
    const bytes = await pluginTgz({ name: "demo-broken" });
    await installPkg("demo-broken", bytes, "enabled");
    await db.deleteFrom("extension_blobs").where("sha256", "=", sha(bytes)).execute();
    const all = await list();
    const b = all.get("demo-broken") as View & { error?: string };
    expect(b).toMatchObject({
      source: "install",
      status: "failed",
      permissions: [],
      added: [],
      removed: [],
      sensitive: false,
      removable: true,
    });
    expect(b.error).toContain(`demo-broken 1.0.0 (${sha(bytes)})`);
    // 其余项不受影响
    expect(all.get("demo-pkg")?.status).toBe("enabled");
    const got = await admin({ method: "GET", url: "/api/v1/admin/plugins/demo-broken" });
    expect(got.statusCode).toBe(409);
    expect(got.json().error.code).toBe("extension.package_unavailable");
    const res = await approve("demo-broken", { sha256: sha(bytes), reviewHash: b.reviewHash });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("extension.package_unavailable");
  });
});
