import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeCatalog,
  type FakeNpmRegistry,
  startFakeCatalog,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import {
  APP_STAGING_CLEANUP_JOB,
  APP_STAGING_CLEANUP_SCHEDULER_ID,
} from "../../src/runtime/maintenance.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { appBundleTgz, mcpTemplate, SVG_ICON, skillTgz } from "./packages.js";

/**
 * 应用包（app.yaml）企业导入（T25，C31）：prepare 校验整个应用包（插件按 lock 从 npm 拉取并按 sha512 校验、
 * 模板、技能）后暂存，confirm 一次批准全部插件、可装到部署并启用、建 kind app 的目录条目。
 */

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 400_000;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let reg: FakeNpmRegistry;
let cat: FakeCatalog;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let member: Req;
let adminId: string;

const pkgs: Record<string, Uint8Array> = {};
const NPM = (name: string) => `@test/plugin-${name}`;

const pluginRef = (name: string, version: string, range = `^${version}`, integrity?: string) => ({
  name,
  npm: NPM(name),
  version: range,
  lock: { version, integrity: integrity ?? sri(pkgs[`${name}@${version}`] as Uint8Array) },
});

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  name: "crm-suite",
  version: "1.0.0",
  publisher: "Acme",
  description: "CRM tools for sales teams",
  displayName: { zh: "CRM 套件", en: "CRM Suite" },
  icon: "icon.svg",
  plugins: [pluginRef("alpha", "1.0.0"), pluginRef("beta", "1.0.0")],
  connectorTemplates: [
    {
      id: "crm-mcp",
      displayName: { zh: "CRM", en: "CRM" },
      template: mcpTemplate({ icon: "icons/crm.svg" }),
    },
  ],
  skills: [{ path: "skills/crm-notes" }],
  ...over,
});

const bundleFiles = [
  { path: "icon.svg", data: SVG_ICON },
  { path: "icons/crm.svg", data: SVG_ICON },
  { path: "skills/crm-notes/SKILL.md", data: SKILL_MD("crm-notes", "Take CRM notes.") },
  { path: "skills/crm-notes/scripts/run.py", data: "print(1)\n" },
  { path: "README.md", data: "not stored\n" },
];

const bundle = (m: Record<string, unknown> | string = manifest(), name?: string) =>
  appBundleTgz({ manifest: m, files: bundleFiles, ...(name !== undefined && { name }) });

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  for (const [name, version] of [
    ["alpha", "1.0.0"],
    ["beta", "1.0.0"],
    ["delta", "1.0.0"],
    ["gamma", "1.0.0"],
    ["gamma", "1.1.0"],
    ["eps", "1.0.0"],
    ["eps", "1.1.0"],
  ] as const) {
    pkgs[`${name}@${version}`] = await lifePkg({ name, version });
  }
  // zeta：2.0.0 没有迁移，1.0.0 有（降级到 1.0.0 时迁移从未执行过）
  pkgs["zeta@2.0.0"] = await lifePkg({ name: "zeta", version: "2.0.0" });
  pkgs["zeta@1.0.0"] = await lifePkg({
    name: "zeta",
    version: "1.0.0",
    migrations: [{ file: "0001_notes.sql", sql: "CREATE TABLE IF NOT EXISTS notes (id int);\n" }],
  });
  // huge：单个包不超过 packages.maxBytes，但应用包加上它超过 directory.maxBundleBytes
  pkgs["huge@1.0.0"] = await pluginTgz({
    name: "huge",
    version: "1.0.0",
    extra: [{ name: "package/dist/blob.txt", data: randomBytes(400_000).toString("base64") }],
  });
  const npmApp = await bundle(manifest({ name: "npm-suite" }), "@acme/app-npm-suite");
  const catApp = await bundle(manifest({ name: "cat-suite" }), "@acme/app-cat-suite");
  pkgs.npmApp = npmApp;
  pkgs.catApp = catApp;
  reg = await startFakeNpmRegistry({
    packages: [
      ...Object.entries(pkgs)
        .filter(([key]) => key.includes("@"))
        .map(([key, tgz]) => {
          const [name, version] = key.split("@") as [string, string];
          return { name: NPM(name), version, tgz };
        }),
      { name: "@acme/app-npm-suite", version: "1.0.0", tgz: npmApp },
      { name: "@acme/app-cat-suite", version: "1.0.0", tgz: catApp },
    ],
  });
  cat = await startFakeCatalog({
    index: {
      schemaVersion: 1,
      name: "Acme",
      updatedAt: "2026-10-22T00:00:00Z",
      entries: [
        {
          kind: "app",
          name: "cat-suite",
          npm: "@acme/app-cat-suite",
          publisher: "Acme",
          summary: { en: "CRM suite" },
          versions: [{ version: "1.0.0", integrity: sri(catApp), minKernel: "0.0.1" }],
        },
      ],
    },
  });
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-app-import-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      pluginHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES, npmRegistry: reg.url },
      directory: { maxBundleBytes: MAX_BUNDLE_BYTES },
      catalogs: { allowInsecureLoopback: true },
      plugins: [S3_PLUGIN, MODEL_FAKE, CONNECTOR_MCP],
      pluginConfig: {
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    },
  );
  k = await createKernel(config, { env: {} });
  await k.start();
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
  await Promise.all([reg?.stop(), cat?.stop()]);
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

async function reset(): Promise<void> {
  // 先停用、卸掉上一组用例装到部署的插件（各副本卸下），再清表
  for (const r of await db.selectFrom("plugin_installs").select("name").execute()) {
    await k.pluginAdminOps.disable(r.name, null);
    await k.pluginAdminOps.uninstall(r.name, null);
  }
  await truncateTables(
    db,
    "capybara.app_import_staging, capybara.directory_item_versions, capybara.directory_items, capybara.plugin_installs, capybara.plugin_permission_snapshots, capybara.plugin_name_owners, capybara.plugin_blobs, capybara.plugin_packages, capybara.audit_events",
  );
  await db.deleteFrom("catalog_sources").where("id", "<>", "official").execute();
  await k.storage.deployment().deletePrefix("directory/");
}

const prepareFile = (req: Req, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: "/api/v1/admin/directory/apps/prepare/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
const confirm = (req: Req, stagingId: string, body: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/admin/directory/apps/${stagingId}/confirm`,
    payload: body,
  });

interface Review {
  name: string;
  version: string;
  plugins: {
    name: string;
    lockVersion: string;
    sha256: string;
    action: string;
    currentVersion: string | null;
    permissions: { category: string; sensitive: boolean; items: string[] }[];
    added: string[];
    reviewHash: string;
    sensitive: boolean;
  }[];
  connectorTemplates: { id: string; plugin: string; connector: string; endpoint: unknown }[];
  skills: { name: string; description: string; files: number }[];
  sensitive: boolean;
  reviewHash: string;
}

async function prepared(bytes: Uint8Array): Promise<{ stagingId: string; review: Review }> {
  const res = await prepareFile(admin, bytes);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function nothingStored(): Promise<void> {
  expect(await db.selectFrom("app_import_staging").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_packages").select("sha256").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_permission_snapshots").select("plugin").execute()).toEqual([]);
  expect((await k.storage.deployment().list("directory/")).items).toEqual([]);
}

describe("prepare / confirm", { timeout: 60_000 }, () => {
  beforeAll(reset);
  let staged: { stagingId: string; review: Review };

  it("prepare：全部校验后暂存；插件按 lock 入库，技能 / 图标 / app.yaml 进对象存储，不建条目", async () => {
    staged = await prepared(await bundle());
    const r = staged.review;
    expect(r).toMatchObject({ name: "crm-suite", version: "1.0.0", sensitive: true });
    expect(r.reviewHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(r.plugins.map((p) => [p.name, p.lockVersion, p.action, p.currentVersion])).toEqual([
      ["alpha", "1.0.0", "install", null],
      ["beta", "1.0.0", "install", null],
    ]);
    const alpha = r.plugins[0];
    expect(alpha?.sha256).toBe(sha256(pkgs["alpha@1.0.0"] as Uint8Array));
    // 权限并集：工具是敏感类别
    expect(alpha?.sensitive).toBe(true);
    expect(alpha?.permissions.find((g) => g.category === "tools")).toMatchObject({
      sensitive: true,
      items: ["wait"],
    });
    expect(alpha?.added.length).toBeGreaterThan(0);
    expect(r.connectorTemplates).toEqual([
      expect.objectContaining({
        id: "crm-mcp",
        plugin: "connector-mcp",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
      }),
    ]);
    expect(r.skills).toEqual([
      expect.objectContaining({ name: "crm-notes", description: "Take CRM notes.", files: 2 }),
    ]);

    const row = await db
      .selectFrom("app_import_staging")
      .selectAll()
      .where("id", "=", staged.stagingId)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(adminId);
    const ttl = row.expires_at.getTime() - row.created_at.getTime();
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(60_000);
    const d = k.storage.deployment();
    const prefix = row.object_prefix as string;
    expect(prefix).toMatch(/^directory\/[0-9a-f-]{36}\/1\.0\.0\/[0-9a-f-]{36}\/$/);
    for (const f of ["app.yaml", "icon.svg", "icons/crm.svg", "skills/crm-notes/SKILL.md"]) {
      expect(await d.head(`${prefix}${f}`), f).not.toBeNull();
    }
    expect(await d.head(`${prefix}README.md`)).toBeNull();
    expect(await d.head(`${prefix}package.json`)).toBeNull();
    const packages = await db
      .selectFrom("plugin_packages")
      .select(["name", "source"])
      .orderBy("name")
      .execute();
    expect(packages).toEqual([
      { name: "alpha", source: "directory" },
      { name: "beta", source: "directory" },
    ]);
    expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("plugin_permission_snapshots").select("plugin").execute()).toEqual(
      [],
    );
    const stagedAudit = await db
      .selectFrom("audit_events")
      .select(["target", "detail", "actor_account_id"])
      .where("action", "=", "directory.app_staged")
      .execute();
    expect(stagedAudit).toEqual([
      {
        target: staged.stagingId,
        actor_account_id: adminId,
        detail: expect.objectContaining({
          stagingId: staged.stagingId,
          name: "crm-suite",
          version: "1.0.0",
          source: "file",
          reviewHash: r.reviewHash,
        }),
      },
    ]);
  });

  it("confirm：reviewHash 不符 409 app.review_stale，什么都不改", async () => {
    const res = await confirm(admin, staged.stagingId, {
      reviewHash: "0000000000000000",
      deployPlugins: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("app.review_stale");
    expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("app_import_staging").select("id").execute()).toHaveLength(1);
  });

  it("confirm：一次批准写入两个插件的快照（source web，审计带 app），建 kind app 的条目", async () => {
    const res = await confirm(admin, staged.stagingId, {
      reviewHash: staged.review.reviewHash,
      deployPlugins: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().deploy).toBeNull();
    const item = res.json().item;
    expect(item).toMatchObject({
      kind: "app",
      name: "crm-suite",
      publisher: "Acme",
      displayName: { zh: "CRM 套件", en: "CRM Suite" },
      description: "CRM tools for sales teams",
      latestVersion: "1.0.0",
      source: "file",
    });
    const snaps = await db
      .selectFrom("plugin_permission_snapshots")
      .select(["plugin", "version", "source", "approved_by"])
      .orderBy("plugin")
      .execute();
    expect(snaps).toEqual([
      { plugin: "alpha", version: "1.0.0", source: "web", approved_by: adminId },
      { plugin: "beta", version: "1.0.0", source: "web", approved_by: adminId },
    ]);
    const approvals = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "plugin.permissions_approved")
      .orderBy("target")
      .execute();
    expect(approvals.map((a) => a.target)).toEqual(["alpha", "beta"]);
    expect(approvals[0]?.detail).toMatchObject({
      app: { name: "crm-suite", version: "1.0.0" },
      sha256: sha256(pkgs["alpha@1.0.0"] as Uint8Array),
    });
    const v = await db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(v.resolved).toEqual({
      plugins: [
        { name: "alpha", sha256: sha256(pkgs["alpha@1.0.0"] as Uint8Array) },
        { name: "beta", sha256: sha256(pkgs["beta@1.0.0"] as Uint8Array) },
      ],
    });
    expect(v.section).toEqual({ kind: "app", manifest: "app.yaml" });
    expect(v.object_prefix).toMatch(new RegExp(`^directory/${item.id}/1\\.0\\.0/`));
    expect((v.files as { path: string }[]).map((f) => f.path).sort()).toEqual([
      "app.yaml",
      "icon.svg",
      "icons/crm.svg",
      "skills/crm-notes/SKILL.md",
      "skills/crm-notes/scripts/run.py",
    ]);
    // 没要求装到部署
    expect(await db.selectFrom("plugin_installs").select("name").execute()).toEqual([]);
    // 暂存已用掉
    expect(await db.selectFrom("app_import_staging").select("id").execute()).toEqual([]);
    const again = await confirm(admin, staged.stagingId, {
      reviewHash: staged.review.reviewHash,
      deployPlugins: false,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("app.staging_not_found");
    // 条目详情带 resolved
    const detail = await admin({ method: "GET", url: `/api/v1/admin/directory/items/${item.id}` });
    expect(detail.json().versions[0].resolved.plugins).toHaveLength(2);
  });

  it("同一版本再 prepare → 409 directory.version_exists（什么都不写）", async () => {
    const res = await prepareFile(admin, await bundle());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.version_exists");
    expect(await db.selectFrom("app_import_staging").select("id").execute()).toEqual([]);
  });

  it("普通导入接口收到应用包 → 409 directory.wrong_kind，指向应用导入", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/directory/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await bundle()),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.wrong_kind");
    expect(res.json().error.message).toMatch(/apps\/prepare/);
  });
});

describe("deployPlugins 与已装插件", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("已装且满足范围的保持原版本（keep，不写快照）；不满足的按 lock 升级；新插件安装并启用（不重启）", async () => {
    // 部署上已有 gamma 1.0.0 与 eps 1.0.0（经插件包上传 + 安装 + 批准）
    for (const name of ["gamma", "eps"]) {
      const rv = await k.pluginInstalls.ingestFile(adminId, pkgs[`${name}@1.0.0`] as Uint8Array);
      await k.pluginAdminOps.install(name, rv.sha256, adminId);
    }
    const snapBefore = await db.selectFrom("plugin_permission_snapshots").selectAll().execute();
    const m = manifest({
      name: "ops-suite",
      plugins: [
        pluginRef("delta", "1.0.0"),
        pluginRef("gamma", "1.1.0", "^1.0.0"),
        pluginRef("eps", "1.1.0", "^1.1.0"),
      ],
      connectorTemplates: [],
      skills: [],
      icon: undefined,
    });
    const s = await prepared(await appBundleTgz({ manifest: m, name: "@acme/app-ops" }));
    expect(s.review.plugins.map((p) => [p.name, p.action, p.currentVersion])).toEqual([
      ["delta", "install", null],
      ["gamma", "keep", "1.0.0"],
      ["eps", "upgrade", "1.0.0"],
    ]);
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployPlugins: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(
      (res.json().deploy as { name: string; action: string; result: string }[]).map((d) => [
        d.name,
        d.action,
        d.result,
      ]),
    ).toEqual([
      ["delta", "install", "enabled"],
      ["eps", "upgrade", "enabled"],
    ]);
    const installs = await db
      .selectFrom("plugin_installs")
      .select(["name", "version", "desired_state"])
      .orderBy("name")
      .execute();
    expect(installs).toEqual([
      { name: "delta", version: "1.0.0", desired_state: "enabled" },
      { name: "eps", version: "1.1.0", desired_state: "enabled" },
      { name: "gamma", version: "1.0.0", desired_state: "disabled" },
    ]);
    // keep 的插件不写快照（F-O）
    const snaps = await db.selectFrom("plugin_permission_snapshots").select("plugin").execute();
    expect(snaps.map((x) => x.plugin).sort()).toEqual(["delta", "eps"]);
    expect(snapBefore).toEqual([]);
    // 不重启：本副本经 reconcile 加载
    await waitFor(async () => k.host.current("delta")?.version === "1.0.0", 15_000, "delta");
    await waitFor(async () => k.host.current("eps")?.version === "1.1.0", 15_000, "eps");
    expect(k.host.current("gamma")).toBeUndefined();
  });

  it("装到部署时某个插件装失败：已提交的条目照常返回，逐个给出结果；upgrade 的快照恢复原样", async () => {
    await reset();
    // 部署上已有 eps 1.0.0 且已批准（快照 1.0.0）
    const rv = await k.pluginInstalls.ingestFile(adminId, pkgs["eps@1.0.0"] as Uint8Array);
    await k.pluginAdminOps.install("eps", rv.sha256, adminId);
    const view = await admin({ method: "GET", url: "/api/v1/admin/plugins/eps" });
    const approved = await admin({
      method: "POST",
      url: "/api/v1/admin/plugins/eps/approve",
      payload: { sha256: view.json().sha256, reviewHash: view.json().reviewHash },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const before = await db
      .selectFrom("plugin_permission_snapshots")
      .selectAll()
      .where("plugin", "=", "eps")
      .executeTakeFirstOrThrow();
    const m = manifest({
      name: "flaky-suite",
      plugins: [pluginRef("delta", "1.0.0"), pluginRef("eps", "1.1.0", "^1.1.0")],
      connectorTemplates: [],
      skills: [],
      icon: undefined,
    });
    const s = await prepared(await appBundleTgz({ manifest: m, name: "@acme/app-flaky" }));
    const original = k.pluginAdminOps.install.bind(k.pluginAdminOps);
    const spy = vi.spyOn(k.pluginAdminOps, "install").mockImplementation(async (name, ...rest) => {
      if (name === "eps") throw new ApiError("plugin.package_not_found", "simulated failure");
      return original(name, ...rest);
    });
    try {
      const res = await confirm(admin, s.stagingId, {
        reviewHash: s.review.reviewHash,
        deployPlugins: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().item).toMatchObject({ kind: "app", name: "flaky-suite" });
      expect(res.json().deploy).toEqual([
        expect.objectContaining({ name: "delta", action: "install", result: "enabled" }),
        expect.objectContaining({
          name: "eps",
          action: "upgrade",
          result: "failed",
          code: "plugin.package_not_found",
          sha256: sha256(pkgs["eps@1.1.0"] as Uint8Array),
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
    // 装上的保持装上；eps 仍是 1.0.0，快照恢复成确认前的样子（运行中的版本照常有效）
    const installs = await db
      .selectFrom("plugin_installs")
      .select(["name", "version", "desired_state"])
      .orderBy("name")
      .execute();
    expect(installs).toEqual([
      { name: "delta", version: "1.0.0", desired_state: "enabled" },
      { name: "eps", version: "1.0.0", desired_state: "disabled" },
    ]);
    const after = await db
      .selectFrom("plugin_permission_snapshots")
      .selectAll()
      .where("plugin", "=", "eps")
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const restored = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.permissions_restored")
      .where("target", "=", "eps")
      .execute();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.detail).toMatchObject({
      restoredVersion: "1.0.0",
      app: { name: "flaky-suite", version: "1.0.0" },
    });
  });

  it("降级到有未执行迁移的版本：prepare 就拒绝 409 plugin.downgrade_unsupported，什么都不写", async () => {
    await reset();
    const rv = await k.pluginInstalls.ingestFile(adminId, pkgs["zeta@2.0.0"] as Uint8Array);
    await k.pluginAdminOps.install("zeta", rv.sha256, adminId);
    const m = manifest({
      name: "old-suite",
      plugins: [pluginRef("zeta", "1.0.0", "^1.0.0")],
      connectorTemplates: [],
      skills: [],
      icon: undefined,
    });
    const res = await prepareFile(
      admin,
      await appBundleTgz({ manifest: m, name: "@acme/app-old" }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("plugin.downgrade_unsupported");
    expect(await db.selectFrom("app_import_staging").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("plugin_permission_snapshots").select("plugin").execute()).toEqual(
      [],
    );
    expect(
      (
        await db
          .selectFrom("plugin_packages")
          .select("version")
          .where("name", "=", "zeta")
          .execute()
      ).map((r) => r.version),
    ).toEqual(["2.0.0"]);
    expect((await k.storage.deployment().list("directory/")).items).toEqual([]);
  });

  it("审阅之后部署状态变了（插件被别人装上）→ app.review_stale", async () => {
    const m = manifest({
      name: "late-suite",
      plugins: [pluginRef("beta", "1.0.0")],
      connectorTemplates: [],
      skills: [],
      icon: undefined,
    });
    const s = await prepared(await appBundleTgz({ manifest: m, name: "@acme/app-late" }));
    expect(s.review.plugins[0]?.action).toBe("install");
    const rv = await k.pluginInstalls.ingestFile(adminId, pkgs["beta@1.0.0"] as Uint8Array);
    await k.pluginAdminOps.install("beta", rv.sha256, adminId);
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployPlugins: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("app.review_stale");
  });
});

describe("恶意 / 不合法的应用包：什么都不写", { timeout: 60_000 }, () => {
  beforeEach(reset);

  it("第二个插件的 lock integrity 被篡改 → 502 app.lock_mismatch", async () => {
    const m = manifest({
      plugins: [
        pluginRef("alpha", "1.0.0"),
        pluginRef("beta", "1.0.0", "^1.0.0", sri(new Uint8Array([1, 2, 3]))),
      ],
    });
    const res = await prepareFile(admin, await bundle(m));
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error.code).toBe("app.lock_mismatch");
    expect(res.json().error.message).toMatch(/@test\/plugin-beta@1\.0\.0/);
    await nothingStored();
  });

  it("lock.version 不满足范围 / 技能目录没有 SKILL.md / 模板端点不合连接器 schema → 400 app.invalid_manifest", async () => {
    const cases: [string, Uint8Array][] = [
      [
        "lock",
        await bundle(
          manifest({
            plugins: [pluginRef("alpha", "1.0.0", "^2.0.0"), pluginRef("beta", "1.0.0")],
          }),
        ),
      ],
      ["skill", await bundle(manifest({ skills: [{ path: "skills/missing" }] }))],
      [
        "endpoint",
        await bundle(
          manifest({
            connectorTemplates: [
              {
                id: "bad",
                displayName: { zh: "x", en: "x" },
                template: mcpTemplate({ icon: "icons/crm.svg", endpoint: { url: 42 } as never }),
              },
            ],
          }),
        ),
      ],
      ["icon", await bundle(manifest({ icon: "missing.svg" }))],
      ["yaml", await bundle("schemaVersion: [\n")],
      [
        "version",
        await appBundleTgz({ manifest: manifest(), version: "2.0.0", files: bundleFiles }),
      ],
    ];
    for (const [label, bytes] of cases) {
      const res = await prepareFile(admin, bytes);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(res.json().error.code, label).toBe("app.invalid_manifest");
    }
    await nothingStored();
  });

  it("模板引用了没列出、部署里也没有的连接器插件 → 400", async () => {
    const res = await prepareFile(
      admin,
      await bundle(
        manifest({
          connectorTemplates: [
            {
              id: "x",
              displayName: { zh: "x", en: "x" },
              template: mcpTemplate({ plugin: "connector-nowhere", icon: "icons/crm.svg" }),
            },
          ],
        }),
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error.details)).toMatch(/connector-nowhere/);
    await nothingStored();
  });

  it("配置声明的插件不满足范围 → 409 app.plugin_conflict", async () => {
    const m = manifest({
      plugins: [
        pluginRef("alpha", "1.0.0"),
        {
          name: "connector-mcp",
          npm: "@capybara-hq/plugin-connector-mcp",
          version: "^9.0.0",
          lock: { version: "9.0.0", integrity: sri(new Uint8Array(1)) },
        },
      ],
    });
    const res = await prepareFile(admin, await bundle(m));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("app.plugin_conflict");
    await nothingStored();
  });

  it("应用包加上锁定的插件包超过 directory.maxBundleBytes → 413 app.bundle_too_large", async () => {
    const res = await prepareFile(
      admin,
      await bundle(
        manifest({ plugins: [pluginRef("alpha", "1.0.0"), pluginRef("huge", "1.0.0")] }),
      ),
    );
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json().error.code).toBe("app.bundle_too_large");
    await nothingStored();
  });

  it("不是应用包 → 409 directory.wrong_kind", async () => {
    const res = await prepareFile(admin, await skillTgz());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.wrong_kind");
    await nothingStored();
  });
});

describe("npm 与清单来源", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("prepare/npm：按 dist.integrity 下载，暂存来源 npm；确认后版本来源 npm", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/directory/apps/prepare/npm",
      payload: { package: "@acme/app-npm-suite" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    expect(s.review.name).toBe("npm-suite");
    const row = await db
      .selectFrom("app_import_staging")
      .select("source")
      .where("id", "=", s.stagingId)
      .executeTakeFirstOrThrow();
    expect(row.source).toMatchObject({
      kind: "npm",
      ref: "@acme/app-npm-suite@1.0.0",
      integrity: sri(pkgs.npmApp as Uint8Array),
    });
    const c = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployPlugins: false,
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().item.source).toBe("npm");
  });

  it("清单引入 kind app：返回 200 {stagingId, review}，确认后条目记下来源清单", async () => {
    const add = await admin({
      method: "POST",
      url: "/api/v1/admin/catalogs",
      payload: { name: "Acme", url: cat.url },
    });
    expect(add.statusCode, add.body).toBe(201);
    const sourceId = add.json().id;
    expect(
      (await admin({ method: "POST", url: `/api/v1/admin/catalogs/${sourceId}/refresh` }))
        .statusCode,
    ).toBe(200);
    const res = await admin({
      method: "POST",
      url: `/api/v1/admin/catalogs/${sourceId}/entries/app/cat-suite/import`,
      payload: { version: "1.0.0" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    expect(s.review.name).toBe("cat-suite");
    expect(s.stagingId).toMatch(/^[0-9a-f-]{36}$/);
    const c = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployPlugins: false,
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().item.source).toBe("catalog");
    const item = await db
      .selectFrom("directory_items")
      .select("catalog_source_id")
      .where("id", "=", c.json().item.id)
      .executeTakeFirstOrThrow();
    expect(item.catalog_source_id).toBe(sourceId);
    const v = await db
      .selectFrom("directory_item_versions")
      .select(["source", "source_ref", "integrity"])
      .where("item_id", "=", c.json().item.id)
      .executeTakeFirstOrThrow();
    expect(v).toEqual({
      source: "catalog",
      source_ref: `${sourceId}:@acme/app-cat-suite@1.0.0`,
      integrity: sri(pkgs.catApp as Uint8Array),
    });
  });
});

describe("暂存过期清理（维护任务 app-staging-cleanup）", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("过期后确认 404；清理删掉暂存行与对象存储前缀", async () => {
    const s = await prepared(await bundle());
    const row = await db
      .selectFrom("app_import_staging")
      .select("object_prefix")
      .where("id", "=", s.stagingId)
      .executeTakeFirstOrThrow();
    const prefix = row.object_prefix as string;
    expect((await k.storage.deployment().list(prefix)).items.length).toBeGreaterThan(0);
    await db
      .updateTable("app_import_staging")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` as unknown as Date })
      .execute();
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployPlugins: false,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("app.staging_not_found");
    expect(await k.apps.cleanupExpired()).toBe(1);
    expect(await db.selectFrom("app_import_staging").select("id").execute()).toEqual([]);
    expect((await k.storage.deployment().list(prefix)).items).toEqual([]);
    expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
  });

  it("任务名与 scheduler id 不含冒号", () => {
    expect(APP_STAGING_CLEANUP_JOB).toBe("app-staging-cleanup");
    expect(APP_STAGING_CLEANUP_SCHEDULER_ID).not.toContain(":");
  });
});

describe("权限", { timeout: 60_000 }, () => {
  it("非企业管理员 403（3 个端点）", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const res of [
      await prepareFile(member, await bundle()),
      await member({
        method: "POST",
        url: "/api/v1/admin/directory/apps/prepare/npm",
        payload: { package: "@acme/app-npm-suite" },
      }),
      await confirm(member, id, { reviewHash: "x", deployPlugins: false }),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
  });
});
