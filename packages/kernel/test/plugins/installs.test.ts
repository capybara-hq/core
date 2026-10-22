import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import {
  type FakeNpmRegistry,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import {
  createKernel,
  KERNEL_MIGRATIONS_DIR,
  type Kernel,
  type KernelOptions,
} from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { PluginApprovals } from "../../src/plugins/approvals.js";
import { blobKey, PluginBlobIntegrityError, PluginBlobs } from "../../src/plugins/blobs.js";
import { permissionSetOfPackage, readPluginPackage } from "../../src/plugins/package.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { packOfficialPlugin, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, runConfig, session } from "../helpers/runs.js";

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const TODO_SRC = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));

const MAX_BYTES = 4 * 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let todo: Uint8Array;
let todoSha: string;
let reg: FakeNpmRegistry;
let pluginsDir: string;

const s3Config = () => ({
  "object-store-s3": {
    endpoint: s3.endpoint,
    region: s3.region,
    bucket: s3.bucket,
    accessKeyId: s3.accessKey,
    secretAccessKey: s3.secretKey,
    forcePathStyle: true,
  },
});

/** 内核日志（JSON 行）收集：断言告警。 */
const logs: { level: string; msg: string; plugin?: string }[] = [];
const capture = () =>
  createLogger("info", {
    write: (line: string) => {
      try {
        logs.push(JSON.parse(line));
      } catch {}
    },
  });

const kernels: Kernel[] = [];
async function boot(
  overrides: Record<string, unknown>,
  opts: Omit<KernelOptions, "env" | "logger"> = {},
): Promise<Kernel> {
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      pluginHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES, npmRegistry: reg.url },
      ...overrides,
    },
  );
  const k = await createKernel(config, { env: {}, logger: capture(), ...opts });
  kernels.push(k);
  await k.start();
  return k;
}
async function stopAll(): Promise<void> {
  while (kernels.length > 0) await kernels.pop()?.stop();
}

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  todo = await packOfficialPlugin("todo");
  todoSha = sha(todo);
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-plugins-"));
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@capybara-hq/plugin-todo", version: "0.1.0", tgz: todo },
      { name: "bad-integrity", version: "1.0.0", tgz: todo, integrity: sri(new Uint8Array(1)) },
      {
        name: "elsewhere",
        version: "1.0.0",
        tgz: todo,
        tarballUrl: "http://203.0.113.9/elsewhere-1.0.0.tgz",
      },
      { name: "redirected", version: "1.0.0", tgz: todo, redirectTarball: true },
      { name: "huge", version: "1.0.0", tgz: new Uint8Array(MAX_BYTES + 1) },
      { name: "wrong-name", version: "0.1.0", tgz: todo },
    ],
  });
}, 240_000);
afterAll(async () => {
  await stopAll();
  await destroyDb?.();
  await reg?.stop();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let admin: Req;
let member: Req;

async function resetData(): Promise<void> {
  await truncateTables(
    db,
    "capybara.plugin_replica_status, capybara.plugin_installs, capybara.plugin_blobs, capybara.plugin_packages, capybara.plugin_permission_snapshots, capybara.plugin_org_configs, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
}
async function loginUsers(k: Kernel): Promise<void> {
  const accounts = new AccountsService(db);
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
  admin = await session(k, "root");
  member = await session(k, "mem");
}

const upload = (req: Req, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: "/api/v1/admin/plugins/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
const fromNpm = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/admin/plugins/packages/npm", payload: body });

describe("有对象存储：上传、npm 与包存储", () => {
  let k: Kernel;
  beforeAll(async () => {
    await resetData();
    k = await boot({ plugins: [S3_PLUGIN, MODEL_FAKE], pluginConfig: s3Config() });
    await loginUsers(k);
  }, 120_000);
  afterAll(stopAll);

  it("上传 todo 包：返回审阅结果，包在 deployment/plugins/blobs/ 下，记来源与审计", async () => {
    const res = await upload(admin, todo);
    expect(res.statusCode, res.body).toBe(200);
    const review = res.json();
    expect(review).toMatchObject({ sha256: todoSha, name: "todo", version: "0.1.0" });
    expect(review.reviewHash).toMatch(/^[0-9a-f]{16}$/);
    expect(review.added).toContain("permissions.tools:write");
    expect(review.removed).toEqual([]);
    expect(review.permissions.map((g: { category: string }) => g.category)).toContain("tools");
    expect(await k.storage.deployment().head(blobKey(todoSha))).not.toBeNull();
    const row = await db
      .selectFrom("plugin_packages")
      .selectAll()
      .where("sha256", "=", todoSha)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: "todo",
      package_name: "@capybara-hq/plugin-todo",
      blob_store: "object",
      source: "file",
    });
    expect(await db.selectFrom("plugin_blobs").select("sha256").execute()).toEqual([]);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "plugin.package_uploaded")
      .execute();
    expect(audit[0]?.detail).toMatchObject({
      name: "todo",
      version: "0.1.0",
      sha256: todoSha,
      source: "file",
    });
  });

  it("get 校验 sha256：对象存储里的字节被篡改就抛错", async () => {
    const blobs = new PluginBlobs({ db, storage: k.storage, maxBytes: () => MAX_BYTES });
    expect(Buffer.from(await blobs.get(todoSha)).equals(Buffer.from(todo))).toBe(true);
    const d = k.storage.deployment();
    await d.put(blobKey(todoSha), new Uint8Array([1, 2, 3]), { contentType: "application/gzip" });
    await expect(blobs.get(todoSha)).rejects.toBeInstanceOf(PluginBlobIntegrityError);
    await d.put(blobKey(todoSha), todo, { contentType: "application/gzip" });
  });

  it("同一个包再传一次：幂等；对象存储里的字节丢了就补回", async () => {
    expect((await upload(admin, todo)).statusCode).toBe(200);
    const rows = await db.selectFrom("plugin_packages").select("sha256").execute();
    expect(rows).toHaveLength(1);
    const d = k.storage.deployment();
    await d.delete(blobKey(todoSha));
    expect(await d.head(blobKey(todoSha))).toBeNull();
    expect((await upload(admin, todo)).statusCode).toBe(200);
    expect(await d.head(blobKey(todoSha))).not.toBeNull();
  });

  it("不合法的包 400 plugin.package_invalid（details 列出问题）；超过上限 413", async () => {
    const bad = await upload(admin, new TextEncoder().encode("not a tgz"));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("plugin.package_invalid");
    expect(bad.json().error.details[0]).toMatch(/gzip/);
    const big = await upload(admin, new Uint8Array(MAX_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("plugin.package_too_large");
  });

  it("与配置声明的插件重名 → 409 plugin.config_declared", async () => {
    const res = await upload(admin, await pluginTgz({ name: "model-fake" }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.config_declared");
  });

  it("已安装的同名插件来自另一个包 → 409 plugin.name_conflict", async () => {
    const own = await pluginTgz({ name: "demo-owned", packageName: "@acme/plugin-demo" });
    expect((await upload(admin, own)).statusCode).toBe(200);
    await db
      .insertInto("plugin_installs")
      .values({ name: "demo-owned", sha256: sha(own), version: "1.0.0", source: "file" })
      .execute();
    const other = await pluginTgz({ name: "demo-owned", packageName: "@evil/plugin-demo" });
    const res = await upload(admin, other);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.name_conflict");
    // 同一个包的新版本不算冲突（升级另行处理）
    const next = await pluginTgz({
      name: "demo-owned",
      packageName: "@acme/plugin-demo",
      version: "1.1.0",
    });
    expect((await upload(admin, next)).statusCode).toBe(200);
  });

  it("非企业管理员 403", async () => {
    expect((await upload(member, todo)).statusCode).toBe(403);
    expect((await fromNpm(member, { package: "@capybara-hq/plugin-todo" })).statusCode).toBe(403);
  });

  it("npm：按 registry 下载并入库，来源 npm", async () => {
    await db.deleteFrom("plugin_installs").execute();
    await db.deleteFrom("plugin_packages").execute();
    const res = await fromNpm(admin, { package: "@capybara-hq/plugin-todo" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sha256: todoSha, name: "todo" });
    const row = await db
      .selectFrom("plugin_packages")
      .select(["source", "source_ref"])
      .where("sha256", "=", todoSha)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ source: "npm", source_ref: "@capybara-hq/plugin-todo@0.1.0" });
  });

  it("npm：integrity 不符、不同源、重定向 → 502；超大 → 413", async () => {
    for (const name of ["bad-integrity", "elsewhere", "redirected", "no-such-package"]) {
      const res = await fromNpm(admin, { package: name });
      expect(res.statusCode, name).toBe(502);
      expect(res.json().error.code).toBe("packages.npm_failed");
    }
    const huge = await fromNpm(admin, { package: "huge" });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error.code).toBe("plugin.package_too_large");
  });

  it("npm：包里的 package.json 名字与请求的包名不一致 → 400 plugin.package_invalid", async () => {
    const res = await fromNpm(admin, { package: "wrong-name" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("plugin.package_invalid");
  });
});

describe("没有对象存储：包存 PG", () => {
  let k: Kernel;
  beforeAll(async () => {
    await resetData();
    k = await boot({ plugins: [MODEL_FAKE] });
    await loginUsers(k);
  }, 120_000);
  afterAll(stopAll);

  it("上传后在 plugin_blobs 里；get 校验 sha256，篡改就抛错", async () => {
    expect((await upload(admin, todo)).statusCode).toBe(200);
    const row = await db
      .selectFrom("plugin_packages")
      .select("blob_store")
      .where("sha256", "=", todoSha)
      .executeTakeFirstOrThrow();
    expect(row.blob_store).toBe("pg");
    const blobs = new PluginBlobs({ db, storage: k.storage, maxBytes: () => MAX_BYTES });
    expect(Buffer.from(await blobs.get(todoSha)).equals(Buffer.from(todo))).toBe(true);
    await db
      .updateTable("plugin_blobs")
      .set({ bytes: Buffer.from("tampered") })
      .where("sha256", "=", todoSha)
      .execute();
    await expect(blobs.get(todoSha)).rejects.toBeInstanceOf(PluginBlobIntegrityError);
    await db
      .updateTable("plugin_blobs")
      .set({ bytes: Buffer.from(todo) })
      .where("sha256", "=", todoSha)
      .execute();
  });
});

describe("启动时加载安装记录", () => {
  beforeAll(async () => {
    await resetData();
  });
  afterAll(stopAll);

  async function installTodo(): Promise<void> {
    const pkg = await readPluginPackage(todo, { maxBytes: MAX_BYTES, hostSdkVersion: SDK_VERSION });
    const blobs = new PluginBlobs({ db, maxBytes: () => MAX_BYTES });
    await blobs.put(pkg, todo, { source: "file", ref: "upload", actor: null, store: "pg" });
    await db
      .insertInto("plugin_installs")
      .values({
        name: "todo",
        sha256: todoSha,
        version: "0.1.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    return void (await new PluginApprovals(db).approve(
      "todo",
      "0.1.0",
      permissionSetOfPackage(pkg),
      { source: "cli" },
    ));
  }

  it("写一条启用的安装记录后启动：todo 从 pluginHost.dir 加载，迁移已执行，组织启用后工具可用", async () => {
    await installTodo();
    const k = await boot({ plugins: [MODEL_FAKE], pluginPermissions: { autoApprove: false } });
    expect(k.host.sourceOf("todo")).toBe("install");
    expect(k.host.manifests().map((m) => m.name)).toContain("todo");
    expect(await readdir(join(pluginsDir, "todo"))).toEqual([todoSha.slice(0, 16)]);
    const inst = await db
      .selectFrom("plugin_installs")
      .select("migrated_sha")
      .where("name", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(inst.migrated_sha).toBe(todoSha);
    const tables = await sql<{ n: string }>`
      SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'plugin_todo'`.execute(
      db,
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    const status = await db
      .selectFrom("plugin_replica_status")
      .selectAll()
      .where("plugin", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(status).toMatchObject({
      replica_id: k.replicaId,
      source: "install",
      sha256: todoSha,
      state: "loaded",
      version: "0.1.0",
    });
    expect(k.replicaId).toMatch(/^.+-\d+-[0-9a-f]{6}$/);

    await loginUsers(k);
    const orgId = await createOrg(admin);
    const ref = { kind: "plugin" as const, plugin: "todo", name: "write" };
    expect((await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools).toEqual([]);
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/todo`,
      payload: { enabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);
    const tools = (await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools;
    expect(tools.map((t) => t.key)).toEqual(["todo__write"]);
    await stopAll();
    const after = await db
      .selectFrom("plugin_replica_status")
      .select(["state", "detail"])
      .where("replica_id", "=", k.replicaId)
      .execute();
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(after.map(() => ({ state: "unloaded", detail: null })));
  });

  it("同一 sha 再次启动复用本地目录（包存储里没有字节也能加载）", async () => {
    await db.deleteFrom("plugin_blobs").execute();
    const k = await boot({ plugins: [MODEL_FAKE], pluginPermissions: { autoApprove: false } });
    expect(k.host.sourceOf("todo")).toBe("install");
    expect(k.host.tools().some((t) => t.plugin === "todo")).toBe(true);
    await stopAll();
  });

  it("没有批准快照：不加载，副本状态 pending / approval；包取不到：failed / sync", async () => {
    await db.deleteFrom("plugin_permission_snapshots").execute();
    const ghost = await pluginTgz({ name: "ghost-pkg" });
    const pkg = await readPluginPackage(ghost, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new PluginBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, ghost, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db.deleteFrom("plugin_blobs").where("sha256", "=", sha(ghost)).execute();
    await db
      .insertInto("plugin_installs")
      .values({
        name: "ghost-pkg",
        sha256: sha(ghost),
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    const k = await boot({ plugins: [MODEL_FAKE], pluginPermissions: { autoApprove: false } });
    expect(k.host.manifests().map((m) => m.name)).not.toContain("todo");
    const rows = await db
      .selectFrom("plugin_replica_status")
      .select(["plugin", "state", "reason"])
      .where("replica_id", "=", k.replicaId)
      .where("plugin", "in", ["todo", "ghost-pkg"])
      .orderBy("plugin")
      .execute();
    expect(rows).toEqual([
      { plugin: "ghost-pkg", state: "failed", reason: "sync" },
      { plugin: "todo", state: "pending", reason: "approval" },
    ]);
    await stopAll();
  });
});

describe("安装记录：迁移目录只认审阅过的 capybara.migrations，模块清单须与静态清单一致", () => {
  beforeAll(async () => {
    await resetData();
  });
  afterAll(stopAll);

  async function installPkg(name: string, bytes: Uint8Array): Promise<void> {
    const pkg = await readPluginPackage(bytes, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new PluginBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, bytes, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db
      .insertInto("plugin_installs")
      .values({
        name,
        sha256: sha(bytes),
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
  }
  const tablesOf = async (schema: string) =>
    (
      await sql<{ n: string }>`
        SELECT table_name AS n FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_name <> '_migrations' ORDER BY 1`.execute(db)
    ).rows.map((r) => r.n);
  const statusOf = (plugin: string) =>
    db
      .selectFrom("plugin_replica_status")
      .select(["state", "reason"])
      .where("plugin", "=", plugin)
      .executeTakeFirstOrThrow();
  const MIGRATIONS = [
    {
      name: "package/migrations/0001_reviewed.sql",
      data: "CREATE TABLE IF NOT EXISTS reviewed (id int);",
    },
    { name: "package/evil/0001_evil.sql", data: "CREATE TABLE IF NOT EXISTS evil (id int);" },
  ];
  const entry = (name: string, extra: string) =>
    [
      'import { definePlugin } from "@capybara-hq/plugin-sdk";',
      `export default definePlugin({ name: "${name}", version: "1.0.0", sdk: "^0.1.0", provides: [], ${extra}, setup() {} });`,
    ].join("\n");

  it("(a) 模块清单声明了另一个 migrations 目录：只执行包里审阅过的 SQL；(b) 模块清单与静态清单不符：failed / manifest_mismatch，不跑迁移", async () => {
    await installPkg(
      "mig-dir",
      await pluginTgz({
        name: "mig-dir",
        section: { migrations: "migrations" },
        extra: MIGRATIONS,
        entry: entry("mig-dir", 'permissions: {}, migrations: "../evil"'),
      }),
    );
    await installPkg(
      "mig-mismatch",
      await pluginTgz({
        name: "mig-mismatch",
        section: { migrations: "migrations" },
        extra: MIGRATIONS,
        entry: entry("mig-mismatch", "permissions: { secrets: true }"),
      }),
    );
    const k = await boot({ plugins: [MODEL_FAKE] });
    expect(k.host.sourceOf("mig-dir")).toBe("install");
    expect(await statusOf("mig-dir")).toEqual({ state: "loaded", reason: null });
    expect(await tablesOf("plugin_mig_dir")).toEqual(["reviewed"]);

    expect(k.host.manifests().map((m) => m.name)).not.toContain("mig-mismatch");
    expect(await statusOf("mig-mismatch")).toEqual({
      state: "failed",
      reason: "manifest_mismatch",
    });
    expect(await tablesOf("plugin_mig_mismatch")).toEqual([]);
    const inst = await db.selectFrom("plugin_installs").select(["name", "migrated_sha"]).execute();
    expect(inst.find((r) => r.name === "mig-mismatch")?.migrated_sha).toBeNull();
    expect(inst.find((r) => r.name === "mig-dir")?.migrated_sha).not.toBeNull();
  });

  it("配置声明的插件 requires 的能力只由安装记录提供：等安装记录加载完再加载；仍无提供方时启动失败", async () => {
    await stopAll();
    const DEPENDENT = fileURLToPath(
      new URL("../fixtures/plugins/everything-dependent/index.ts", import.meta.url),
    );
    // 没有任何提供方：与此前一样，内核启动失败并点名
    await expect(boot({ plugins: [MODEL_FAKE, DEPENDENT] })).rejects.toThrow(
      /everything-dependent: required capability counter@1 has no provider/,
    );
    await installPkg(
      "inst-counter",
      await pluginTgz({
        name: "inst-counter",
        manifest: { provides: ["counter@1"] },
        entry: [
          'import { definePlugin } from "@capybara-hq/plugin-sdk";',
          'export default definePlugin({ name: "inst-counter", version: "1.0.0", sdk: "^0.1.0", provides: ["counter@1"], permissions: {}, setup(ctx) { ctx.provide("counter@1", { n: 1 }); } });',
        ].join("\n"),
      }),
    );
    const k = await boot({ plugins: [MODEL_FAKE, DEPENDENT] });
    expect(k.host.sourceOf("inst-counter")).toBe("install");
    expect(k.host.sourceOf("everything-dependent")).toBe("config");
    const names = k.host.manifests().map((m) => m.name);
    expect(names).toContain("everything-dependent");
    expect(names.indexOf("inst-counter")).toBeLessThan(names.indexOf("everything-dependent"));
  });
});

describe("内置插件", () => {
  beforeAll(async () => {
    await resetData();
    logs.length = 0;
  });
  afterAll(stopAll);

  it("来源 builtin：autoApprove 关闭也直接加载、不写快照；组织插件页不列出，组织启用检查直接放行", async () => {
    // 同名的安装记录：被忽略，冲突记在生效那一行的 detail 里
    const pkg = await readPluginPackage(todo, { maxBytes: MAX_BYTES, hostSdkVersion: SDK_VERSION });
    await new PluginBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, todo, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db
      .insertInto("plugin_installs")
      .values({
        name: "todo",
        sha256: todoSha,
        version: "0.1.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    const k = await boot(
      // 配置列表里也写了 todo：以内置为准并告警
      { plugins: [MODEL_FAKE, TODO_SRC], pluginPermissions: { autoApprove: false } },
      // object-store-s3 没有部署配置：待配置，内核照常启动
      { builtinPlugins: [TODO_SRC, S3_PLUGIN] },
    );
    expect(k.host.sourceOf("todo")).toBe("builtin");
    expect(k.host.manifests().map((m) => m.name)).toContain("todo");
    const todoRow = await db
      .selectFrom("plugin_replica_status")
      .select(["source", "state", "detail"])
      .where("plugin", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(todoRow.source).toBe("builtin");
    expect(todoRow.state).toBe("loaded");
    expect(todoRow.detail).toMatch(/^name_conflict: install record 0\.1\.0/);
    expect(await db.selectFrom("plugin_permission_snapshots").select("plugin").execute()).toEqual(
      [],
    );
    expect(
      logs.some((l) => l.level === "warn" && /built in/.test(l.msg) && l.plugin === "todo"),
    ).toBe(true);
    const s3Row = await db
      .selectFrom("plugin_replica_status")
      .select(["source", "state", "reason"])
      .where("plugin", "=", "object-store-s3")
      .executeTakeFirstOrThrow();
    expect(s3Row).toEqual({ source: "builtin", state: "pending", reason: "config" });
    expect(k.storage.available).toBe(false);

    await loginUsers(k);
    const orgId = await createOrg(admin);
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/plugins` });
    expect(list.statusCode).toBe(200);
    expect(list.json().plugins.map((p: { plugin: string }) => p.plugin)).not.toContain("todo");
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/todo`,
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(404);
    const ref = { kind: "plugin" as const, plugin: "todo", name: "write" };
    const tools = (await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools;
    expect(tools.map((t) => t.key)).toEqual(["todo__write"]);
    expect((await k.host.enabledPlugins(orgId)).has("todo")).toBe(true);
    // 安装同名包 → 409 plugin.builtin
    const res = await upload(admin, todo);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.builtin");
  });
});
