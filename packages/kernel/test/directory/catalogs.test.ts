import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeCatalog,
  type FakeNpmRegistry,
  startFakeCatalog,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { CATALOG_ENTRIES_MAX } from "../../src/directory/catalogs.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import {
  CATALOGS_REFRESH_JOB,
  CATALOGS_REFRESH_SCHEDULER_ID,
  MAINTENANCE_QUEUE_NAME,
} from "../../src/runtime/maintenance.js";
import { truncateTables } from "../helpers/db.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";

const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const MAX_INDEX_BYTES = 64 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let reg: FakeNpmRegistry;
let official: FakeCatalog;
let cat: FakeCatalog;
let mirror: FakeCatalog;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let member: Req;

const pkgs: Record<string, Uint8Array> = {};

const entry = (
  name: string,
  versions: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) => ({
  kind: "plugin",
  name,
  npm: `@acme/plugin-${name}`,
  publisher: "Acme",
  summary: { en: `${name} plugin`, zh: name },
  permissions: { keys: [], sensitive: [] },
  versions,
  ...over,
});
const ver = (bytes: Uint8Array, over: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  integrity: sri(bytes),
  minKernel: "0.1.0",
  minSdk: "0.1.0",
  ...over,
});

let catalogIndex: () => Record<string, unknown>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  for (const n of ["cat-a", "cat-b", "cat-c", "cat-e"]) {
    pkgs[n] = await pluginTgz({ name: n, version: "1.0.0", packageName: `@acme/plugin-${n}` });
  }
  pkgs["cat-a@2"] = await pluginTgz({
    name: "cat-a",
    version: "2.0.0",
    packageName: "@acme/plugin-cat-a",
  });
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@acme/plugin-cat-a", version: "1.0.0", tgz: pkgs["cat-a"] as Uint8Array },
      { name: "@acme/plugin-cat-a", version: "2.0.0", tgz: pkgs["cat-a@2"] as Uint8Array },
      { name: "@acme/plugin-cat-b", version: "1.0.0", tgz: pkgs["cat-b"] as Uint8Array },
      // npm 元数据的 integrity 与 tgz 一致，但清单给的 sha512 是别的包的
      { name: "@acme/plugin-cat-c", version: "1.0.0", tgz: pkgs["cat-c"] as Uint8Array },
      // 请求 @acme/plugin-cat-d，包里却是 @acme/plugin-cat-a
      { name: "@acme/plugin-cat-d", version: "1.0.0", tgz: pkgs["cat-a"] as Uint8Array },
      { name: "@acme/plugin-cat-e", version: "1.0.0", tgz: pkgs["cat-e"] as Uint8Array },
    ],
  });
  catalogIndex = () => ({
    schemaVersion: 1,
    name: "Acme catalog",
    updatedAt: "2026-10-22T00:00:00Z",
    entries: [
      entry("cat-a", [ver(pkgs["cat-a"] as Uint8Array)], {
        permissions: { keys: ["permissions.secrets"], sensitive: ["permissions.secrets"] },
      }),
      entry("cat-b", [
        ver(pkgs["cat-b"] as Uint8Array, {
          tarball: `${reg.url}/@acme/plugin-cat-b/-/plugin-cat-b-1.0.0.tgz`,
        }),
      ]),
      entry("cat-c", [ver(pkgs["cat-a"] as Uint8Array)]),
      entry("cat-d", [ver(pkgs["cat-a"] as Uint8Array)]),
      entry("cat-e", [ver(pkgs["cat-e"] as Uint8Array, { minKernel: "99.0.0" })]),
    ],
  });
  official = await startFakeCatalog({
    index: { schemaVersion: 1, name: "Official", updatedAt: "2026-10-22T00:00:00Z", entries: [] },
  });
  cat = await startFakeCatalog({ index: catalogIndex() });
  mirror = await startFakeCatalog({ index: catalogIndex() });
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-catalogs-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api"],
      pluginHost: { dir: pluginsDir },
      packages: { npmRegistry: reg.url },
      catalogs: {
        official: { enabled: true, url: official.url },
        maxIndexBytes: MAX_INDEX_BYTES,
        allowInsecureLoopback: true,
      },
    },
  );
  k = await createKernel(config, { env: {} });
  await k.start();
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
}, 240_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([reg?.stop(), official?.stop(), cat?.stop(), mirror?.stop()]);
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const addCatalog = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/admin/catalogs", payload: body });
const refresh = (req: Req, id: string) =>
  req({ method: "POST", url: `/api/v1/admin/catalogs/${id}/refresh` });
const importEntry = (req: Req, id: string, name: string, version = "1.0.0", kind = "plugin") =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalogs/${id}/entries/${kind}/${name}/import`,
    payload: { version },
  });

async function resetAll(): Promise<void> {
  await truncateTables(
    db,
    "capybara.directory_item_versions, capybara.directory_items, capybara.plugin_installs, capybara.plugin_blobs, capybara.plugin_packages, capybara.plugin_name_owners, capybara.audit_events",
  );
  await db.deleteFrom("catalog_sources").where("id", "<>", "official").execute();
  await db.deleteFrom("secrets").where("key", "like", "catalog-token:%").execute();
  cat.setIndex(catalogIndex());
  cat.setRedirect(null);
}

/** 手动刷新失败：502 + 错误码，状态已记好，返回来源视图。 */
async function failedRefresh(id: string, code: string) {
  const res = await refresh(admin, id);
  expect(res.statusCode, res.body).toBe(502);
  expect(res.json().error.code).toBe(code);
  expect(res.json().error.message).toMatch(/previous entries are kept/);
  return k.catalogs.get(id);
}

async function addAcme(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await addCatalog(admin, { name: "Acme", url: cat.url, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

async function nothingImported(): Promise<void> {
  expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("directory_item_versions").select("item_id").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_packages").select("sha256").execute()).toEqual([]);
}

describe("官方清单", () => {
  beforeEach(resetAll);

  it("启动时按配置建 official 来源（builtin），列表里能看到；不能删除，只能停用", async () => {
    const list = await admin({ method: "GET", url: "/api/v1/admin/catalogs" });
    expect(list.statusCode, list.body).toBe(200);
    const off = list.json().items.find((s: { id: string }) => s.id === "official");
    expect(off).toMatchObject({
      id: "official",
      builtin: true,
      url: official.url,
      mirrors: [],
      enabled: true,
      disabledByConfig: false,
      hasToken: false,
      lastStatus: expect.stringMatching(/^(never|ok|error)$/),
    });
    const del = await admin({ method: "DELETE", url: "/api/v1/admin/catalogs/official" });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("catalog.builtin");
    const rename = await admin({
      method: "PATCH",
      url: "/api/v1/admin/catalogs/official",
      payload: { url: "https://example.com/index.json" },
    });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe("catalog.builtin");
    const disable = await admin({
      method: "PATCH",
      url: "/api/v1/admin/catalogs/official",
      payload: { enabled: false },
    });
    expect(disable.statusCode, disable.body).toBe(200);
    expect(disable.json()).toMatchObject({ id: "official", enabled: false });
    const again = await admin({
      method: "PATCH",
      url: "/api/v1/admin/catalogs/official",
      payload: { enabled: true },
    });
    expect(again.json()).toMatchObject({ enabled: true });
  });

  it("刷新官方清单（空清单）状态 ok", async () => {
    const res = await refresh(admin, "official");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ lastStatus: "ok", entryCount: 0, lastError: null });
    const etag = res.json().etag;
    expect(etag).toBeTruthy();
    // 再次按配置同步：地址没变保留 ETag；地址变了（这里模拟库里是旧地址）清掉 ETag
    await k.catalogs.syncOfficialFromConfig();
    expect((await k.catalogs.get("official")).etag).toBe(etag);
    await db
      .updateTable("catalog_sources")
      .set({ url: "https://old.example.com/index.json" })
      .where("id", "=", "official")
      .execute();
    await k.catalogs.syncOfficialFromConfig();
    expect(await k.catalogs.get("official")).toMatchObject({ url: official.url, etag: null });
  });
});

describe("企业清单：增删改与刷新", () => {
  beforeEach(resetAll);

  it("只认 https（回环 http 只在 allowInsecureLoopback 下）；镜像同样；不能带用户信息", async () => {
    for (const url of [
      "http://example.com/index.json",
      "ftp://example.com/index.json",
      "https://user:pw@example.com/index.json",
      "not a url",
    ]) {
      const res = await addCatalog(admin, { name: "X", url });
      expect(res.statusCode, url).toBe(400);
    }
    const badMirror = await addCatalog(admin, {
      name: "X",
      url: cat.url,
      mirrors: ["http://example.com/m.json"],
    });
    expect(badMirror.statusCode).toBe(400);
  });

  it("刷新：条目进缓存；第二次带 If-None-Match 拿到 304；不合法的清单保留旧条目、状态 error；只在状态变化时审计", async () => {
    const id = await addAcme();
    const r1 = await refresh(admin, id);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ lastStatus: "ok", entryCount: 5, lastError: null });
    const etag = r1.json().etag;
    expect(etag).toMatch(/^".+"$/);

    const r2 = await refresh(admin, id);
    expect(r2.json()).toMatchObject({ lastStatus: "ok", entryCount: 5 });
    expect(cat.requests.at(-1)).toEqual({ etag });

    cat.setIndex("{not json");
    const r3 = await failedRefresh(id, "catalog.invalid");
    expect(r3).toMatchObject({ lastStatus: "error", entryCount: 5, etag });
    expect(r3.lastError).toMatch(/JSON/);

    cat.setIndex({ ...catalogIndex(), entries: [{ kind: "plugin", name: "x" }] });
    const r4 = await failedRefresh(id, "catalog.invalid");
    expect(r4).toMatchObject({ lastStatus: "error", entryCount: 5 });
    expect(r4.lastError).toMatch(/entries\.0/);

    const entries = await admin({
      method: "GET",
      url: `/api/v1/admin/catalogs/entries?sourceId=${id}`,
    });
    expect(entries.json().items.map((e: { name: string }) => e.name)).toEqual([
      "cat-a",
      "cat-b",
      "cat-c",
      "cat-d",
      "cat-e",
    ]);

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "catalog.refreshed")
      .orderBy("id")
      .execute();
    expect(audits.map((a) => (a.detail as { to: string }).to)).toEqual(["ok", "error"]);
  });

  it("重定向不跟随、超过 maxIndexBytes 被拒，都保留旧条目", async () => {
    const id = await addAcme();
    expect((await refresh(admin, id)).json().lastStatus).toBe("ok");
    cat.setRedirect(official.url);
    const r = await failedRefresh(id, "catalog.fetch_failed");
    expect(r).toMatchObject({ lastStatus: "error", entryCount: 5 });
    expect(r.lastError).toMatch(/redirect/);
    cat.setRedirect(null);
    const pad = "x".repeat(280);
    cat.setIndex({
      ...catalogIndex(),
      entries: Array.from({ length: 300 }, (_, i) =>
        entry(`big-${i}`, [ver(pkgs["cat-a"] as Uint8Array)], { summary: { en: pad } }),
      ),
    });
    const big = await failedRefresh(id, "catalog.fetch_failed");
    expect(big).toMatchObject({ lastStatus: "error", entryCount: 5 });
    expect(big.lastError).toMatch(/larger than/);
  });

  it("主地址失败时依次尝试镜像；令牌只发往清单地址的源，不发给别的源的镜像；列表不回显令牌", async () => {
    const id = await addAcme({ token: "s3cret-token", mirrors: [mirror.url] });
    const list = await admin({ method: "GET", url: "/api/v1/admin/catalogs" });
    const view = list.json().items.find((s: { id: string }) => s.id === id);
    expect(view).toMatchObject({ hasToken: true, mirrors: [mirror.url] });
    expect(list.body).not.toContain("s3cret-token");

    const r1 = await refresh(admin, id);
    expect(r1.json().lastStatus).toBe("ok");
    expect(cat.requests.at(-1)?.authorization).toBe("Bearer s3cret-token");

    cat.setRedirect("https://example.com/");
    const before = mirror.requests.length;
    const r2 = await refresh(admin, id);
    expect(r2.json()).toMatchObject({ lastStatus: "ok", entryCount: 5 });
    expect(mirror.requests.length).toBe(before + 1);
    expect(mirror.requests.at(-1)?.authorization).toBeUndefined();

    // 清除令牌
    const patched = await admin({
      method: "PATCH",
      url: `/api/v1/admin/catalogs/${id}`,
      payload: { token: null },
    });
    expect(patched.json()).toMatchObject({ hasToken: false });
  });

  it("删除企业清单：条目随之删除，已引入的目录条目保留；refreshAll 某个来源失败不影响其他来源", async () => {
    const id = await addAcme();
    const broken = await addCatalog(admin, { name: "Broken", url: `${cat.url}?broken` });
    const brokenId = broken.json().id;
    // 主地址返回 404 的来源
    await db
      .updateTable("catalog_sources")
      .set({ url: cat.url.replace("index.json", "missing.json") })
      .where("id", "=", brokenId)
      .execute();
    await k.catalogs.refreshAll(AbortSignal.timeout(10_000));
    const views = await k.catalogs.list();
    expect(views.find((v) => v.id === id)).toMatchObject({ lastStatus: "ok", entryCount: 5 });
    expect(views.find((v) => v.id === brokenId)).toMatchObject({ lastStatus: "error" });

    const imp = await importEntry(admin, id, "cat-a");
    expect(imp.statusCode, imp.body).toBe(201);
    const del = await admin({ method: "DELETE", url: `/api/v1/admin/catalogs/${id}` });
    expect(del.statusCode).toBe(204);
    expect(
      await db.selectFrom("catalog_entries").select("name").where("source_id", "=", id).execute(),
    ).toEqual([]);
    const item = await db.selectFrom("directory_items").selectAll().executeTakeFirstOrThrow();
    expect(item).toMatchObject({ name: "cat-a", catalog_source_id: null, deleted_at: null });
    const missing = await admin({ method: "DELETE", url: `/api/v1/admin/catalogs/${id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("catalog.not_found");
  });
});

describe("从清单引入", () => {
  let id: string;
  beforeEach(async () => {
    await resetAll();
    id = await addAcme();
    expect((await refresh(admin, id)).json().lastStatus).toBe("ok");
  });

  it("引入插件：按清单 sha512 校验，建目录条目（来源 catalog），记 integrity 与来源", async () => {
    const res = await importEntry(admin, id, "cat-a");
    expect(res.statusCode, res.body).toBe(201);
    const { item } = res.json();
    expect(item).toMatchObject({
      kind: "plugin",
      name: "cat-a",
      latestVersion: "1.0.0",
      source: "catalog",
    });
    const v = await db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(v).toMatchObject({
      source: "catalog",
      source_ref: `${id}:@acme/plugin-cat-a@1.0.0`,
      integrity: sri(pkgs["cat-a"] as Uint8Array),
      plugin_sha256: sha256(pkgs["cat-a"] as Uint8Array),
    });
    const row = await db
      .selectFrom("directory_items")
      .select("catalog_source_id")
      .where("id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(row.catalog_source_id).toBe(id);
    const pkg = await db
      .selectFrom("plugin_packages")
      .select(["source", "source_ref"])
      .executeTakeFirstOrThrow();
    expect(pkg).toEqual({
      source: "directory",
      source_ref: `catalog:${id}:@acme/plugin-cat-a@1.0.0`,
    });
    const audit = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "directory.imported")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      source: "catalog",
      catalogSourceId: id,
      version: "1.0.0",
    });
    // 清单的权限摘要（permissions.secrets）与包算出的（无权限）不符：只警告
    expect(res.json().permissionsMismatch).toEqual({ missing: [], extra: ["permissions.secrets"] });

    // 条目视图：已引入、版本兼容、没有新版本
    const entries = await admin({
      method: "GET",
      url: `/api/v1/admin/catalogs/entries?sourceId=${id}&kind=plugin&q=cat-a`,
    });
    expect(entries.statusCode, entries.body).toBe(200);
    expect(entries.json().items).toHaveLength(1);
    expect(entries.json().items[0]).toMatchObject({
      sourceId: id,
      sourceName: "Acme",
      name: "cat-a",
      npm: "@acme/plugin-cat-a",
      adopted: { itemId: item.id, versions: ["1.0.0"] },
      newerAvailable: false,
      versions: [{ version: "1.0.0", compatible: true }],
    });

    // 清单出了新版本：标「有新版本」，不自动引入
    cat.setIndex({
      ...catalogIndex(),
      entries: [
        entry("cat-a", [
          ver(pkgs["cat-a"] as Uint8Array),
          ver(pkgs["cat-a@2"] as Uint8Array, { version: "2.0.0" }),
        ]),
      ],
    });
    await refresh(admin, id);
    const after = await admin({
      method: "GET",
      url: `/api/v1/admin/catalogs/entries?sourceId=${id}`,
    });
    expect(after.json().items[0]).toMatchObject({ newerAvailable: true });
    // 后台条目视图：来源清单里最高的兼容版本与「有新版本」
    const items = await admin({ method: "GET", url: "/api/v1/admin/directory/items" });
    expect(items.json().items[0]).toMatchObject({
      name: "cat-a",
      catalogSourceId: id,
      latestCatalogVersion: "2.0.0",
      newerInCatalog: true,
    });
    expect(await db.selectFrom("directory_item_versions").select("version").execute()).toHaveLength(
      1,
    );
    const up = await importEntry(admin, id, "cat-a", "2.0.0");
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().item).toMatchObject({ latestVersion: "2.0.0", versions: ["2.0.0", "1.0.0"] });
  });

  it("integrity 不符：tgz 与 npm 元数据一致但与清单不同 → 502 catalog.integrity_mismatch，什么都没建", async () => {
    const res = await importEntry(admin, id, "cat-c");
    expect(res.statusCode, res.body).toBe(502);
    const err = res.json().error;
    expect(err.code).toBe("catalog.integrity_mismatch");
    const want = sri(pkgs["cat-a"] as Uint8Array).slice(7, 19);
    const got = sri(pkgs["cat-c"] as Uint8Array).slice(7, 19);
    expect(err.message).toContain(want);
    expect(err.message).toContain(got);
    expect(err.message).toMatch(/does not match the catalog/);
    await nothingImported();
  });

  it("清单给了 tarball 时从该地址下载，不请求 registry 元数据", async () => {
    const before = reg.requests.length;
    const res = await importEntry(admin, id, "cat-b");
    expect(res.statusCode, res.body).toBe(201);
    const reqs = reg.requests.slice(before);
    expect(reqs).toEqual(["/@acme/plugin-cat-b/-/plugin-cat-b-1.0.0.tgz"]);
  });

  it("minKernel 太高 409 catalog.incompatible；包名与条目不符 409 catalog.package_mismatch；都不写", async () => {
    const inc = await importEntry(admin, id, "cat-e");
    expect(inc.statusCode, inc.body).toBe(409);
    expect(inc.json().error.code).toBe("catalog.incompatible");
    const mis = await importEntry(admin, id, "cat-d");
    expect(mis.statusCode, mis.body).toBe(409);
    expect(mis.json().error.code).toBe("catalog.package_mismatch");
    await nothingImported();
  });

  it("条目 / 版本 / 来源不存在 404", async () => {
    const noEntry = await importEntry(admin, id, "nope");
    expect(noEntry.statusCode).toBe(404);
    expect(noEntry.json().error.code).toBe("catalog.entry_not_found");
    const noVersion = await importEntry(admin, id, "cat-a", "9.9.9");
    expect(noVersion.statusCode).toBe(404);
    expect(noVersion.json().error.code).toBe("catalog.entry_not_found");
    const noSource = await importEntry(admin, "00000000-0000-0000-0000-000000000000", "cat-a");
    expect(noSource.statusCode).toBe(404);
    expect(noSource.json().error.code).toBe("catalog.not_found");
    const badKind = await importEntry(admin, id, "cat-a", "1.0.0", "theme");
    expect(badKind.statusCode).toBe(400);
  });

  it("停用的来源不显示条目，也不能引入", async () => {
    await admin({
      method: "PATCH",
      url: `/api/v1/admin/catalogs/${id}`,
      payload: { enabled: false },
    });
    const entries = await admin({ method: "GET", url: "/api/v1/admin/catalogs/entries" });
    expect(entries.json().items.filter((e: { sourceId: string }) => e.sourceId === id)).toEqual([]);
    const res = await importEntry(admin, id, "cat-a");
    expect(res.statusCode).toBe(404);
  });

  it("非企业管理员 403", async () => {
    const calls = [
      member({ method: "GET", url: "/api/v1/admin/catalogs" }),
      addCatalog(member, { name: "X", url: cat.url }),
      member({ method: "PATCH", url: `/api/v1/admin/catalogs/${id}`, payload: { name: "Y" } }),
      member({ method: "DELETE", url: `/api/v1/admin/catalogs/${id}` }),
      refresh(member, id),
      member({ method: "GET", url: "/api/v1/admin/catalogs/entries" }),
      importEntry(member, id, "cat-a"),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode, res.body).toBe(403);
    await nothingImported();
  });
});

describe("定期刷新（维护任务 catalogs-refresh）", () => {
  it("worker 副本登记一个 scheduler（id / 任务名不含冒号，周期 refreshIntervalMinutes），首轮立即刷新生效的来源", async () => {
    await resetAll();
    await db
      .updateTable("catalog_sources")
      .set({ last_status: "never", etag: null })
      .where("id", "=", "official")
      .execute();
    const before = official.requests.length;
    const worker = await createKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["worker"],
          pluginHost: { dir: pluginsDir },
          packages: { npmRegistry: reg.url },
          catalogs: {
            official: { enabled: true, url: official.url },
            refreshIntervalMinutes: 30,
            allowInsecureLoopback: true,
          },
        },
      ),
      { env: {} },
    );
    await worker.start();
    const maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
    try {
      expect(CATALOGS_REFRESH_JOB).toBe("catalogs-refresh");
      expect(CATALOGS_REFRESH_SCHEDULER_ID).not.toContain(":");
      const s = (await maint.getJobSchedulers()).filter(
        (x) => x.key === CATALOGS_REFRESH_SCHEDULER_ID,
      );
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ name: CATALOGS_REFRESH_JOB, every: 30 * 60_000 });
      await expect
        .poll(async () => (await k.catalogs.get("official")).lastStatus, { timeout: 15_000 })
        .toBe("ok");
      expect(official.requests.length).toBeGreaterThan(before);
      await maint.removeJobScheduler(CATALOGS_REFRESH_SCHEDULER_ID);
    } finally {
      await maint.close();
      await worker.stop();
    }
  }, 60_000);
});

describe("浏览条目的上限", () => {
  beforeEach(resetAll);

  it("超过 CATALOG_ENTRIES_MAX 条时只返回上限条数并标 truncated；没超过为 false", async () => {
    const id = await addAcme();
    const small = await admin({
      method: "GET",
      url: `/api/v1/admin/catalogs/entries?sourceId=${id}`,
    });
    expect(small.json()).toEqual({ items: [], truncated: false });
    const rows = Array.from({ length: CATALOG_ENTRIES_MAX + 1 }, (_, i) => {
      const e = entry(`bulk-${String(i).padStart(5, "0")}`, [ver(pkgs["cat-a"] as Uint8Array)]);
      return {
        source_id: id,
        kind: "plugin" as const,
        name: e.name,
        npm: e.npm,
        entry: JSON.stringify(e),
      };
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await db
        .insertInto("catalog_entries")
        .values(rows.slice(i, i + 1000))
        .execute();
    }
    const big = await admin({
      method: "GET",
      url: `/api/v1/admin/catalogs/entries?sourceId=${id}`,
    });
    expect(big.statusCode, big.body).toBe(200);
    expect(big.json().truncated).toBe(true);
    expect(big.json().items).toHaveLength(CATALOG_ENTRIES_MAX);
  }, 60_000);
});
