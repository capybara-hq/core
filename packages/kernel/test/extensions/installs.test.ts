import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import {
  type FakeNpmRegistry,
  fakeExtensionEntry,
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
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionApprovals } from "../../src/extensions/approvals.js";
import {
  blobKey,
  ExtensionBlobIntegrityError,
  ExtensionBlobs,
} from "../../src/extensions/blobs.js";
import { permissionSetOfPackage, readExtensionPackage } from "../../src/extensions/package.js";
import {
  createKernel,
  KERNEL_MIGRATIONS_DIR,
  type Kernel,
  type KernelOptions,
} from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, legacyTgz, packFake, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, runConfig, session } from "../helpers/runs.js";

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

const MAX_BYTES = 4 * 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let toolsUi: Uint8Array;
let toolsUiSha: string;
let reg: FakeNpmRegistry;
let pluginsDir: string;

const s3Config = () => ({
  "fake-object-store": {
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
      extensionHost: { dir: pluginsDir },
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
  // Only its extension (tool, view, migration), like an extension-only plugin: its connector
  // template would need fake-connector loaded, which these tests don't load
  toolsUi = await packFake("fake-tools-ui", async (dir) => {
    await rm(join(dir, "connectors"), { recursive: true });
    await rm(join(dir, "skills"), { recursive: true });
  });
  toolsUiSha = sha(toolsUi);
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-plugins-"));
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@capybara-hq/test-plugin-fake-tools-ui", version: "0.1.0", tgz: toolsUi },
      { name: "bad-integrity", version: "1.0.0", tgz: toolsUi, integrity: sri(new Uint8Array(1)) },
      {
        name: "elsewhere",
        version: "1.0.0",
        tgz: toolsUi,
        tarballUrl: "http://203.0.113.9/elsewhere-1.0.0.tgz",
      },
      { name: "redirected", version: "1.0.0", tgz: toolsUi, redirectTarball: true },
      { name: "huge", version: "1.0.0", tgz: new Uint8Array(MAX_BYTES + 1) },
      { name: "wrong-name", version: "0.1.0", tgz: toolsUi },
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
    "capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.extension_org_configs, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
}
async function loginUsers(k: Kernel): Promise<void> {
  const accounts = accountsFor(db);
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
    url: "/api/v1/admin/extensions/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
const fromNpm = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/admin/extensions/packages/npm", payload: body });

describe("有对象存储：上传、npm 与包存储", () => {
  let k: Kernel;
  beforeAll(async () => {
    await resetData();
    k = await boot({ extensions: [OBJECT_STORE, MODEL_FAKE], extensionConfig: s3Config() });
    await loginUsers(k);
  }, 120_000);
  afterAll(stopAll);

  it("上传 fake-tools-ui 包：返回审阅结果，包在 deployment/plugins/blobs/ 下，记来源与审计", async () => {
    const res = await upload(admin, toolsUi);
    expect(res.statusCode, res.body).toBe(200);
    const review = res.json();
    expect(review).toMatchObject({ sha256: toolsUiSha, name: "fake-tools-ui", version: "0.1.0" });
    expect(review.reviewHash).toMatch(/^[0-9a-f]{16}$/);
    expect(review.added).toContain("permissions.tools:write");
    expect(review.removed).toEqual([]);
    expect(review.permissions.map((g: { category: string }) => g.category)).toContain("tools");
    expect(await k.storage.deployment().head(blobKey(toolsUiSha))).not.toBeNull();
    const row = await db
      .selectFrom("extension_packages")
      .selectAll()
      .where("sha256", "=", toolsUiSha)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: "fake-tools-ui",
      package_name: "@capybara-hq/test-plugin-fake-tools-ui",
      blob_store: "object",
      source: "file",
    });
    expect(await db.selectFrom("extension_blobs").select("sha256").execute()).toEqual([]);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "extension.package_uploaded")
      .execute();
    expect(audit[0]?.detail).toMatchObject({
      name: "fake-tools-ui",
      version: "0.1.0",
      sha256: toolsUiSha,
      source: "file",
    });
  });

  it("get 校验 sha256：对象存储里的字节被篡改就抛错", async () => {
    const blobs = new ExtensionBlobs({ db, storage: k.storage, maxBytes: () => MAX_BYTES });
    expect(Buffer.from(await blobs.get(toolsUiSha)).equals(Buffer.from(toolsUi))).toBe(true);
    const d = k.storage.deployment();
    await d.put(blobKey(toolsUiSha), new Uint8Array([1, 2, 3]), {
      contentType: "application/gzip",
    });
    await expect(blobs.get(toolsUiSha)).rejects.toBeInstanceOf(ExtensionBlobIntegrityError);
    await d.put(blobKey(toolsUiSha), toolsUi, { contentType: "application/gzip" });
  });

  it("同一个包再传一次：幂等；对象存储里的字节丢了就补回", async () => {
    expect((await upload(admin, toolsUi)).statusCode).toBe(200);
    const rows = await db.selectFrom("extension_packages").select("sha256").execute();
    expect(rows).toHaveLength(1);
    const d = k.storage.deployment();
    await d.delete(blobKey(toolsUiSha));
    expect(await d.head(blobKey(toolsUiSha))).toBeNull();
    // 对象没了（如换了桶）：报错点名缺的键与补救办法
    await expect(
      new ExtensionBlobs({ db, storage: k.storage, maxBytes: () => MAX_BYTES }).get(toolsUiSha),
    ).rejects.toThrow(
      /deployment\/plugins\/blobs\/[0-9a-f]{64}\.tgz is missing there; if the object store's bucket/,
    );
    expect((await upload(admin, toolsUi)).statusCode).toBe(200);
    expect(await d.head(blobKey(toolsUiSha))).not.toBeNull();
  });

  it("an invalid package is 400 extension.package_invalid (details list the problems); over the limit 413", async () => {
    const bad = await upload(admin, new TextEncoder().encode("not a tgz"));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("extension.package_invalid");
    expect(bad.json().error.details[0]).toMatch(/gzip/);
    const big = await upload(admin, new Uint8Array(MAX_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("extension.package_too_large");
  });

  it("a pre-0.1.0 tgz (capybara section, or app.yaml) is 422 extension.legacy_format with the repack message; a plugin without an extension is 400 extension.no_extension; nothing is stored", async () => {
    const LEGACY =
      "uses the pre-0.1.0 package format (capybara section / app.yaml); repack it as a plugin with .capybara-plugin/plugin.json (pnpm pack-plugin)";
    const before = await db.selectFrom("extension_packages").select("sha256").execute();
    for (const bytes of [await legacyTgz(), await legacyTgz({ appYaml: true })]) {
      const res = await upload(admin, bytes);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe("extension.legacy_format");
      expect(res.json().error.message).toBe(`Package @test/plugin-legacy-pkg ${LEGACY}`);
    }
    const skillsOnly = await pluginTgz({
      manifest: { name: "skills-only" },
      files: {
        "skills/greet/SKILL.md":
          "---\nname: greet\ndescription: Greets the user. Use when the user says hello.\n---\n\nHi.\n",
      },
    });
    const res = await upload(admin, skillsOnly);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("extension.no_extension");
    expect(await db.selectFrom("extension_packages").select("sha256").execute()).toEqual(before);
  });

  it("same name as a config-declared extension -> 409 extension.config_declared", async () => {
    const res = await upload(
      admin,
      await pluginTgz({ manifest: { name: "model-fake" }, extension: {} }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("extension.config_declared");
  });

  it("an installed extension of the same name comes from another package -> 409 extension.name_conflict", async () => {
    const own = await pluginTgz({
      manifest: { name: "demo-owned" },
      packageName: "@acme/plugin-demo",
      extension: {},
    });
    expect((await upload(admin, own)).statusCode).toBe(200);
    await db
      .insertInto("extension_installs")
      .values({ name: "demo-owned", sha256: sha(own), version: "1.0.0", source: "file" })
      .execute();
    const other = await pluginTgz({
      manifest: { name: "demo-owned" },
      packageName: "@evil/plugin-demo",
      extension: {},
    });
    const res = await upload(admin, other);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("extension.name_conflict");
    // 同一个包的新版本不算冲突（升级另行处理）
    const next = await pluginTgz({
      manifest: { name: "demo-owned", version: "1.1.0" },
      packageName: "@acme/plugin-demo",
      extension: {},
    });
    expect((await upload(admin, next)).statusCode).toBe(200);
  });

  it("非企业管理员 403", async () => {
    expect((await upload(member, toolsUi)).statusCode).toBe(403);
    expect(
      (await fromNpm(member, { package: "@capybara-hq/test-plugin-fake-tools-ui" })).statusCode,
    ).toBe(403);
  });

  it("上传先认证再读请求体：未登录 / 非企业管理员的超大请求体 401 / 403（不是 413）；其他内核路由不收 octet-stream", async () => {
    const huge = new Uint8Array(MAX_BYTES * 2);
    const anon = await k.http.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/packages/file",
      headers: { "content-type": "application/octet-stream", "x-capybara-csrf": "1" },
      payload: Buffer.from(huge),
    });
    expect(anon.statusCode, anon.body).toBe(401);
    expect(anon.json().error.code).toBe("auth.required");
    const mem = await upload(member, huge);
    expect(mem.statusCode, mem.body).toBe(403);
    expect(mem.json().error.code).toBe("forbidden");
    // Cookie 认证缺 CSRF 头同样在读请求体之前拒绝
    const noCsrf = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/packages/file",
      csrf: false,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(huge),
    });
    expect(noCsrf.json().error.code).toBe("auth.csrf");
    const other = await admin({
      method: "POST",
      url: "/api/v1/orgs",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("{}"),
    });
    expect(other.statusCode, other.body).toBe(415);
    expect(other.json().error.code).toBe("unsupported_media_type");
  });

  it("npm：按 registry 下载并入库，来源 npm", async () => {
    await db.deleteFrom("extension_installs").execute();
    await db.deleteFrom("extension_packages").execute();
    const res = await fromNpm(admin, { package: "@capybara-hq/test-plugin-fake-tools-ui" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sha256: toolsUiSha, name: "fake-tools-ui" });
    const row = await db
      .selectFrom("extension_packages")
      .select(["source", "source_ref"])
      .where("sha256", "=", toolsUiSha)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      source: "npm",
      source_ref: "@capybara-hq/test-plugin-fake-tools-ui@0.1.0",
    });
  });

  it("npm：integrity 不符、不同源、重定向 → 502；超大 → 413", async () => {
    for (const name of ["bad-integrity", "elsewhere", "redirected", "no-such-package"]) {
      const res = await fromNpm(admin, { package: name });
      expect(res.statusCode, name).toBe(502);
      expect(res.json().error.code).toBe("packages.npm_failed");
    }
    const huge = await fromNpm(admin, { package: "huge" });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error.code).toBe("extension.package_too_large");
  });

  it("npm: the package.json name in the package differs from the requested package -> 400 extension.package_invalid", async () => {
    const res = await fromNpm(admin, { package: "wrong-name" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("extension.package_invalid");
  });
});

describe("没有对象存储：包存 PG", () => {
  let k: Kernel;
  beforeAll(async () => {
    await resetData();
    k = await boot({ extensions: [MODEL_FAKE] });
    await loginUsers(k);
  }, 120_000);
  afterAll(stopAll);

  it("after upload it is in extension_blobs; get checks sha256 and throws when tampered with", async () => {
    expect((await upload(admin, toolsUi)).statusCode).toBe(200);
    const row = await db
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", toolsUiSha)
      .executeTakeFirstOrThrow();
    expect(row.blob_store).toBe("pg");
    const blobs = new ExtensionBlobs({ db, storage: k.storage, maxBytes: () => MAX_BYTES });
    expect(Buffer.from(await blobs.get(toolsUiSha)).equals(Buffer.from(toolsUi))).toBe(true);
    await db
      .updateTable("extension_blobs")
      .set({ bytes: Buffer.from("tampered") })
      .where("sha256", "=", toolsUiSha)
      .execute();
    await expect(blobs.get(toolsUiSha)).rejects.toBeInstanceOf(ExtensionBlobIntegrityError);
    await db
      .updateTable("extension_blobs")
      .set({ bytes: Buffer.from(toolsUi) })
      .where("sha256", "=", toolsUiSha)
      .execute();
  });
});

describe("启动时加载安装记录", () => {
  beforeAll(async () => {
    await resetData();
  });
  afterAll(stopAll);

  async function installToolsUi(): Promise<void> {
    const pkg = await readExtensionPackage(toolsUi, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    const blobs = new ExtensionBlobs({ db, maxBytes: () => MAX_BYTES });
    await blobs.put(pkg, toolsUi, { source: "file", ref: "upload", actor: null, store: "pg" });
    await db
      .insertInto("extension_installs")
      .values({
        name: "fake-tools-ui",
        sha256: toolsUiSha,
        version: "0.1.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    return void (await new ExtensionApprovals(db).approve(
      "fake-tools-ui",
      "0.1.0",
      permissionSetOfPackage(pkg),
      { source: "cli" },
    ));
  }

  it("写一条启用的安装记录后启动：fake-tools-ui 从 extensionHost.dir 加载，迁移已执行，组织启用后工具可用", async () => {
    await installToolsUi();
    const k = await boot({
      extensions: [MODEL_FAKE],
      extensionPermissions: { autoApprove: false },
    });
    expect(k.host.sourceOf("fake-tools-ui")).toBe("install");
    expect(k.host.manifests().map((m) => m.name)).toContain("fake-tools-ui");
    expect(await readdir(join(pluginsDir, "fake-tools-ui"))).toEqual([toolsUiSha.slice(0, 16)]);
    const inst = await db
      .selectFrom("extension_installs")
      .select("migrated_sha")
      .where("name", "=", "fake-tools-ui")
      .executeTakeFirstOrThrow();
    expect(inst.migrated_sha).toBe(toolsUiSha);
    const tables = await sql<{ n: string }>`
      SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'plugin_fake_tools_ui'`.execute(
      db,
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    const status = await db
      .selectFrom("extension_replica_status")
      .selectAll()
      .where("plugin", "=", "fake-tools-ui")
      .executeTakeFirstOrThrow();
    expect(status).toMatchObject({
      replica_id: k.replicaId,
      source: "install",
      sha256: toolsUiSha,
      state: "loaded",
      version: "0.1.0",
    });
    expect(k.replicaId).toMatch(/^.+-\d+-[0-9a-f]{6}$/);

    await loginUsers(k);
    const orgId = await createOrg(admin);
    const ref = { kind: "plugin" as const, plugin: "fake-tools-ui", name: "write" };
    expect((await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools).toEqual([]);
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-tools-ui`,
      payload: { enabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);
    const tools = (await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools;
    expect(tools.map((t) => t.key)).toEqual(["fake-tools-ui__write"]);
    await stopAll();
    const after = await db
      .selectFrom("extension_replica_status")
      .select(["state", "detail"])
      .where("replica_id", "=", k.replicaId)
      .execute();
    // 正常停机删掉本副本的状态行（不再标 unloaded 留着，部署状态不必等心跳过期）
    expect(after).toEqual([]);
  });

  it("同一 sha 再次启动复用本地目录（包存储里没有字节也能加载）", async () => {
    await db.deleteFrom("extension_blobs").execute();
    const k = await boot({
      extensions: [MODEL_FAKE],
      extensionPermissions: { autoApprove: false },
    });
    expect(k.host.sourceOf("fake-tools-ui")).toBe("install");
    expect(k.host.tools().some((t) => t.plugin === "fake-tools-ui")).toBe(true);
    await stopAll();
  });

  it("没有批准快照：不加载，副本状态 pending / approval；包取不到：failed / sync_failed", async () => {
    await db.deleteFrom("extension_permission_snapshots").execute();
    const ghost = await pluginTgz({ manifest: { name: "ghost-pkg" }, extension: {} });
    const pkg = await readExtensionPackage(ghost, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    await new ExtensionBlobs({ db, maxBytes: () => MAX_BYTES }).put(pkg, ghost, {
      source: "file",
      ref: "upload",
      actor: null,
      store: "pg",
    });
    await db.deleteFrom("extension_blobs").where("sha256", "=", sha(ghost)).execute();
    await db
      .insertInto("extension_installs")
      .values({
        name: "ghost-pkg",
        sha256: sha(ghost),
        version: "1.0.0",
        source: "file",
        desired_state: "enabled",
      })
      .execute();
    const k = await boot({
      extensions: [MODEL_FAKE],
      extensionPermissions: { autoApprove: false },
    });
    expect(k.host.manifests().map((m) => m.name)).not.toContain("fake-tools-ui");
    const rows = await db
      .selectFrom("extension_replica_status")
      .select(["plugin", "state", "reason"])
      .where("replica_id", "=", k.replicaId)
      .where("plugin", "in", ["fake-tools-ui", "ghost-pkg"])
      .orderBy("plugin")
      .execute();
    expect(rows).toEqual([
      { plugin: "fake-tools-ui", state: "pending", reason: "approval" },
      { plugin: "ghost-pkg", state: "failed", reason: "sync_failed" },
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
      .selectFrom("extension_replica_status")
      .select(["state", "reason"])
      .where("plugin", "=", plugin)
      .executeTakeFirstOrThrow();
  const MIGRATIONS = {
    "migrations/0001_reviewed.sql": "CREATE TABLE IF NOT EXISTS reviewed (id int);",
    "evil/0001_evil.sql": "CREATE TABLE IF NOT EXISTS evil (id int);",
  };
  const entry = (name: string, extra: string) =>
    [
      'import { defineExtension } from "@capybara-hq/plugin-sdk";',
      `export default defineExtension({ name: "${name}", version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [], ${extra}, setup() {} });`,
    ].join("\n");

  it("(a) 模块清单声明了另一个 migrations 目录：只执行包里审阅过的 SQL；(b) 模块清单与静态清单不符：failed / manifest_mismatch，不跑迁移", async () => {
    await installPkg(
      "mig-dir",
      await pluginTgz({
        manifest: { name: "mig-dir" },
        files: MIGRATIONS,
        extension: {
          section: { migrations: "./migrations" },
          entry: entry("mig-dir", 'permissions: {}, migrations: "../evil"'),
        },
      }),
    );
    await installPkg(
      "mig-mismatch",
      await pluginTgz({
        manifest: { name: "mig-mismatch" },
        files: MIGRATIONS,
        extension: {
          section: { migrations: "./migrations" },
          entry: entry("mig-mismatch", "permissions: { secrets: true }"),
        },
      }),
    );
    const k = await boot({ extensions: [MODEL_FAKE] });
    expect(k.host.sourceOf("mig-dir")).toBe("install");
    expect(await statusOf("mig-dir")).toEqual({ state: "loaded", reason: null });
    expect(await tablesOf("plugin_mig_dir")).toEqual(["reviewed"]);

    expect(k.host.manifests().map((m) => m.name)).not.toContain("mig-mismatch");
    expect(await statusOf("mig-mismatch")).toEqual({
      state: "failed",
      reason: "manifest_mismatch",
    });
    expect(await tablesOf("plugin_mig_mismatch")).toEqual([]);
    const inst = await db
      .selectFrom("extension_installs")
      .select(["name", "migrated_sha"])
      .execute();
    expect(inst.find((r) => r.name === "mig-mismatch")?.migrated_sha).toBeNull();
    expect(inst.find((r) => r.name === "mig-dir")?.migrated_sha).not.toBeNull();
  });

  it("配置声明的插件 requires 的能力只由安装记录提供：等安装记录加载完再加载；仍无提供方时启动失败", async () => {
    await stopAll();
    const DEPENDENT = fileURLToPath(
      new URL("../fixtures/plugins/everything-dependent/index.ts", import.meta.url),
    );
    // 没有任何提供方：与此前一样，内核启动失败并点名
    await expect(boot({ extensions: [MODEL_FAKE, DEPENDENT] })).rejects.toThrow(
      /everything-dependent: required extension point counter@1 has no provider/,
    );
    await installPkg(
      "inst-counter",
      await pluginTgz({
        manifest: { name: "inst-counter" },
        extension: {
          manifest: { provides: ["counter@1"] },
          entry: [
            'import { defineExtension } from "@capybara-hq/plugin-sdk";',
            'export default defineExtension({ name: "inst-counter", version: "1.0.0", sdk: "^0.1.0-rc.0", provides: ["counter@1"], permissions: {}, setup(ctx) { ctx.provide("counter@1", { n: 1 }); } });',
          ].join("\n"),
        },
      }),
    );
    const k = await boot({ extensions: [MODEL_FAKE, DEPENDENT] });
    expect(k.host.sourceOf("inst-counter")).toBe("install");
    expect(k.host.sourceOf("everything-dependent")).toBe("config");
    const names = k.host.manifests().map((m) => m.name);
    expect(names).toContain("everything-dependent");
    expect(names.indexOf("inst-counter")).toBeLessThan(names.indexOf("everything-dependent"));
  });
  it("延后加载的配置声明插件：提供方安装记录没加载成 → 待定 dependency、内核照常启动；路由闸门按部署已知状态 503 / 404", async () => {
    await stopAll();
    const DEPENDENT = fileURLToPath(
      new URL("../fixtures/plugins/everything-dependent/index.ts", import.meta.url),
    );
    await db.deleteFrom("extension_installs").where("name", "=", "inst-counter").execute();
    // 模块清单比审阅过的静态清单多要了 secrets：failed / manifest_mismatch
    await installPkg(
      "bad-counter",
      await pluginTgz({
        manifest: { name: "bad-counter" },
        extension: {
          manifest: { provides: ["counter@1"] },
          entry: [
            'import { defineExtension } from "@capybara-hq/plugin-sdk";',
            'export default defineExtension({ name: "bad-counter", version: "1.0.0", sdk: "^0.1.0-rc.0", provides: ["counter@1"], permissions: { secrets: true }, setup(ctx) { ctx.provide("counter@1", {}); } });',
          ].join("\n"),
        },
      }),
    );
    const k = await boot({ extensions: [MODEL_FAKE, DEPENDENT] });
    const status = async (plugin: string) =>
      db
        .selectFrom("extension_replica_status")
        .select(["state", "reason"])
        .where("replica_id", "=", k.replicaId)
        .where("plugin", "=", plugin)
        .executeTakeFirst();
    expect(await status("bad-counter")).toEqual({ state: "failed", reason: "manifest_mismatch" });
    expect(await status("everything-dependent")).toEqual({
      state: "pending",
      reason: "dependency",
    });
    expect(k.host.pending()).toContainEqual(
      expect.objectContaining({
        plugin: "everything-dependent",
        reason: "dependency",
        blockedBy: [{ extensionPoint: "counter@1", providers: ["bad-counter"] }],
      }),
    );
    const get = (name: string) => k.http.inject({ method: "GET", url: `/plugins/${name}/x` });
    // 安装记录（PG）与配置声明的插件都是部署已知的：不在本副本生效 → 503；完全未知 → 404
    for (const name of ["bad-counter", "mig-mismatch", "everything-dependent"]) {
      const r = await get(name);
      expect(r.statusCode, name).toBe(503);
      expect((r.json() as { error: { code: string } }).error.code).toBe("extension.unavailable");
    }
    expect((await get("nobody")).statusCode).toBe(404);
  });

  it("延后加载链：中间的配置声明插件待配置 → 顶端待定 dependency（不让启动失败）；PG 补上配置后一起加载", async () => {
    await stopAll();
    const fixture = (n: string) =>
      fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
    await installPkg(
      "chain-counter",
      await pluginTgz({
        manifest: { name: "chain-counter" },
        extension: {
          manifest: { provides: ["counter@1"] },
          entry: [
            'import { defineExtension } from "@capybara-hq/plugin-sdk";',
            'export default defineExtension({ name: "chain-counter", version: "1.0.0", sdk: "^0.1.0-rc.0", provides: ["counter@1"], permissions: {}, setup(ctx) { ctx.provide("counter@1", { n: 1 }); } });',
          ].join("\n"),
        },
      }),
    );
    const k = await boot({ extensions: [MODEL_FAKE, fixture("chain-mid"), fixture("chain-top")] });
    const status = async (plugin: string) =>
      db
        .selectFrom("extension_replica_status")
        .select(["state", "reason"])
        .where("replica_id", "=", k.replicaId)
        .where("plugin", "=", plugin)
        .executeTakeFirst();
    expect(k.host.current("chain-counter")).toBeDefined();
    expect(await status("chain-mid")).toEqual({ state: "pending", reason: "config" });
    expect(await status("chain-top")).toEqual({ state: "pending", reason: "dependency" });
    await db
      .insertInto("extension_deployment_configs")
      .values({ plugin: "chain-mid", config: JSON.stringify({ port: 1 }) })
      .execute();
    await k.extensionLifecycle.reconcile("test");
    expect(k.host.current("chain-mid")?.config).toEqual({ port: 1 });
    expect(k.host.current("chain-top")).toBeDefined();
    await db.deleteFrom("extension_deployment_configs").where("plugin", "=", "chain-mid").execute();
  });
});

describe("引导插件（取代内置插件）", () => {
  let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
  beforeAll(async () => {
    await resetData();
    fx = await bootstrapFixture([
      { bytes: toolsUi },
      { bytes: await packFake("fake-bootstrap-b") },
    ]);
  }, 120_000);
  afterAll(async () => {
    await stopAll();
    await fx?.cleanup();
  });

  it("安装记录来源 bootstrap：autoApprove 关闭也加载（快照来源 bootstrap）；组织不需启用，不能停用", async () => {
    const k = await boot(
      { extensions: [MODEL_FAKE], extensionPermissions: { autoApprove: false } },
      // fake-bootstrap-b 没有部署配置：待配置，内核照常启动
      { bootstrap: { dir: fx.dir }, bootstrapManifest: fx.manifest },
    );
    expect(k.host.sourceOf("fake-tools-ui")).toBe("install");
    expect(k.host.manifests().map((m) => m.name)).toContain("fake-tools-ui");
    const toolsUiRow = await db
      .selectFrom("extension_replica_status")
      .select(["source", "state"])
      .where("plugin", "=", "fake-tools-ui")
      .executeTakeFirstOrThrow();
    expect(toolsUiRow).toEqual({ source: "install", state: "loaded" });
    expect(
      await db
        .selectFrom("extension_permission_snapshots")
        .select(["plugin", "source"])
        .orderBy("plugin")
        .execute(),
    ).toEqual([
      { plugin: "fake-bootstrap-b", source: "bootstrap" },
      { plugin: "fake-tools-ui", source: "bootstrap" },
    ]);
    const s3Row = await db
      .selectFrom("extension_replica_status")
      .select(["source", "state", "reason"])
      .where("plugin", "=", "fake-bootstrap-b")
      .executeTakeFirstOrThrow();
    expect(s3Row).toEqual({ source: "install", state: "pending", reason: "config" });
    expect(k.storage.available).toBe(false);

    await loginUsers(k);
    const orgId = await createOrg(admin);
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().extensions.find((p: { plugin: string }) => p.plugin === "fake-tools-ui"),
    ).toMatchObject({ enabled: true, required: true });
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-tools-ui`,
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("extension.required");
    const ref = { kind: "plugin" as const, plugin: "fake-tools-ui", name: "write" };
    const tools = (await k.tools.registry.forAgent(orgId, { tools: [ref] })).tools;
    expect(tools.map((t) => t.key)).toEqual(["fake-tools-ui__write"]);
    expect((await k.host.enabledPlugins(orgId)).has("fake-tools-ui")).toBe(true);
    // The same package uploaded again is just the installed package (nothing new to approve)
    const res = await upload(admin, toolsUi);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sha256: toolsUiSha, added: [] });
  });
});
