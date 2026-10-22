import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeNpmRegistry,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { packOfficialPlugin, pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";
import { appTgz, mcpTemplate, skillTgz, skillZip, templateTgz } from "./packages.js";

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);

const MAX_BYTES = 4 * 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let reg: FakeNpmRegistry;
let pluginsDir: string;
let todo: Uint8Array;
let k: Kernel;
let admin: Req;
let member: Req;
let memberId: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  todo = await packOfficialPlugin("todo");
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-directory-"));
  reg = await startFakeNpmRegistry({
    packages: [
      { name: "@capybara-hq/plugin-todo", version: "0.1.0", tgz: todo },
      {
        name: "@acme/skill-pdf-tools",
        version: "2.0.0",
        tgz: await skillTgz({ version: "2.0.0" }),
      },
      {
        name: "@acme/skill-tampered",
        version: "1.0.0",
        tgz: await skillTgz({ name: "@acme/skill-tampered" }),
        integrity: sri(new Uint8Array(1)),
      },
      // 请求的是 @acme/other，包里的 package.json 却叫 @acme/skill-pdf-tools
      { name: "@acme/other", version: "1.0.0", tgz: await skillTgz() },
    ],
  });
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      pluginHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES, npmRegistry: reg.url },
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
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  admin = await session(k, "root");
  member = await session(k, "mem");
}, 240_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await reg?.stop();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

async function resetDirectory(): Promise<void> {
  await truncateTables(
    db,
    "capybara.directory_item_versions, capybara.directory_items, capybara.plugin_installs, capybara.plugin_blobs, capybara.plugin_packages, capybara.audit_events",
  );
  await k.storage.deployment().deletePrefix("directory/");
}

const importFile = (req: Req, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: "/api/v1/admin/directory/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
const importNpm = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/admin/directory/import/npm", payload: body });

async function nothingStored(): Promise<void> {
  expect(await db.selectFrom("directory_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("directory_item_versions").select("item_id").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_packages").select("sha256").execute()).toEqual([]);
  expect((await k.storage.deployment().list("directory/")).items).toEqual([]);
}

describe("技能", () => {
  beforeAll(resetDirectory);

  it("导入 tgz：建条目，文件放 deployment/directory/<itemId>/<version>/，写审计", async () => {
    const res = await importFile(admin, await skillTgz());
    expect(res.statusCode, res.body).toBe(201);
    const item = res.json();
    expect(item).toMatchObject({
      kind: "skill",
      name: "pdf-tools",
      publisher: "Acme",
      displayName: null,
      description: "PDF helpers",
      policy: "allow",
      latestVersion: "1.0.0",
      versions: ["1.0.0"],
      installs: 0,
      source: "file",
    });
    const d = k.storage.deployment();
    expect(await d.head(`directory/${item.id}/1.0.0/SKILL.md`)).not.toBeNull();
    expect(await d.head(`directory/${item.id}/1.0.0/scripts/run.py`)).not.toBeNull();
    expect(await d.head(`directory/${item.id}/1.0.0/package.json`)).toBeNull();
    const v = await db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(v).toMatchObject({
      version: "1.0.0",
      source: "file",
      object_prefix: `directory/${item.id}/1.0.0/`,
      plugin_sha256: null,
    });
    expect((v.files as { path: string }[]).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.py",
    ]);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "target", "detail"])
      .where("action", "=", "directory.imported")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      target: item.id,
      detail: { kind: "skill", name: "pdf-tools", version: "1.0.0", source: "file" },
    });
  });

  it("同一版本重复导入 409 directory.version_exists；zip 的新版本加到同一条目", async () => {
    const dup = await importFile(admin, await skillTgz());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("directory.version_exists");
    const res = await importFile(admin, skillZip({ version: "1.1.0" }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ latestVersion: "1.1.0", versions: ["1.1.0", "1.0.0"] });
    const list = await admin({ method: "GET", url: "/api/v1/admin/directory/items?kind=skill" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it("另一个 npm 包用同一个技能名 409 directory.name_conflict", async () => {
    const res = await importFile(admin, await skillTgz({ name: "@evil/pdf", version: "9.0.0" }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.name_conflict");
  });

  it("从 npm 导入：来源 npm，记 integrity", async () => {
    const res = await importNpm(admin, { package: "@acme/skill-pdf-tools", version: "2.0.0" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ latestVersion: "2.0.0", source: "npm" });
    const v = await db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("version", "=", "2.0.0")
      .executeTakeFirstOrThrow();
    expect(v.source).toBe("npm");
    expect(v.source_ref).toBe("@acme/skill-pdf-tools@2.0.0");
    expect(v.integrity).toMatch(/^sha512-/);
  });

  it("npm 的 integrity 不符 502、包名与请求的不符 400，都不写", async () => {
    const before = await db.selectFrom("directory_item_versions").select("version").execute();
    const bad = await importNpm(admin, { package: "@acme/skill-tampered" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.code).toBe("packages.npm_failed");
    const other = await importNpm(admin, { package: "@acme/other" });
    expect(other.statusCode).toBe(400);
    expect(other.json().error.code).toBe("directory.invalid_package");
    expect(await db.selectFrom("directory_item_versions").select("version").execute()).toEqual(
      before,
    );
  });

  it("详情含各版本", async () => {
    const id = (
      await db
        .selectFrom("directory_items")
        .select("id")
        .where("name", "=", "pdf-tools")
        .executeTakeFirstOrThrow()
    ).id;
    const res = await admin({ method: "GET", url: `/api/v1/admin/directory/items/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json();
    expect(detail.item.versions).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(detail.versions[0]).toMatchObject({ version: "2.0.0", source: "npm" });
    expect(detail.versions[0].section).toMatchObject({ kind: "skill" });
  });
});

describe("连接器模板", () => {
  beforeAll(resetDirectory);

  it("按连接器的 endpointSchema 校验通过后导入，图标放进存储", async () => {
    const res = await importFile(admin, await templateTgz());
    expect(res.statusCode, res.body).toBe(201);
    const item = res.json();
    expect(item).toMatchObject({
      kind: "connector-template",
      name: "github-mcp",
      displayName: { zh: "GitHub", en: "GitHub" },
    });
    expect(await k.storage.deployment().head(`directory/${item.id}/1.0.0/icon.svg`)).not.toBeNull();
  });

  it("模板里含凭据字段被拒，什么都不写", async () => {
    await resetDirectory();
    for (const template of [
      mcpTemplate({ auth: { type: "bearer", ownership: "org", token: "s3cr3t" } }),
      mcpTemplate({ endpoint: { url: "https://x.example/mcp", headers: { Authorization: "x" } } }),
    ]) {
      const res = await importFile(admin, await templateTgz({ template }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("directory.invalid_package");
      expect(res.body).not.toMatch(/s3cr3t/);
    }
    await nothingStored();
  });

  it("editableEndpoint 指向 schema 里不存在的路径被拒", async () => {
    const res = await importFile(
      admin,
      await templateTgz({ template: mcpTemplate({ editableEndpoint: ["url", "baseUrl"] }) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("directory.invalid_package");
    expect(JSON.stringify(res.json().error)).toMatch(/baseUrl/);
    // 记录类型字段下的任意键可编辑（headers.X-Tenant）
    const ok = await importFile(
      admin,
      await templateTgz({
        template: mcpTemplate({ editableEndpoint: ["url", "headers.X-Tenant"] }),
      }),
    );
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("端点不符合连接器的 schema、连接器插件没加载、kind 不对都被拒", async () => {
    for (const template of [
      mcpTemplate({ endpoint: { url: "http://insecure.example/mcp" } }),
      mcpTemplate({ plugin: "connector-nope" }),
      mcpTemplate({ connector: "openapi" }),
    ]) {
      const res = await importFile(admin, await templateTgz({ template, version: "2.0.0" }));
      expect(res.statusCode, `${JSON.stringify(template)} ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe("directory.invalid_package");
    }
  });
});

describe("插件", () => {
  beforeAll(resetDirectory);

  it("插件 tgz 交给插件包流程：进 plugin_packages（来源 directory，ref <itemId>@<version>）", async () => {
    const res = await importFile(admin, todo);
    expect(res.statusCode, res.body).toBe(201);
    const item = res.json();
    expect(item).toMatchObject({ kind: "plugin", name: "todo", latestVersion: "0.1.0" });
    const pkg = await db
      .selectFrom("plugin_packages")
      .selectAll()
      .where("sha256", "=", sha256(todo))
      .executeTakeFirstOrThrow();
    expect(pkg).toMatchObject({ source: "directory", source_ref: `${item.id}@0.1.0` });
    const v = await db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(v).toMatchObject({ plugin_sha256: sha256(todo), object_prefix: null, source: "file" });
  });

  it("从 npm 导入同一版本 409", async () => {
    const res = await importNpm(admin, { package: "@capybara-hq/plugin-todo" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.version_exists");
  });

  it("装到部署：调用插件安装，安装记录关联条目；非插件条目 409 directory.wrong_kind", async () => {
    const item = await db
      .selectFrom("directory_items")
      .select("id")
      .where("name", "=", "todo")
      .executeTakeFirstOrThrow();
    const res = await admin({
      method: "POST",
      url: `/api/v1/admin/directory/items/${item.id}/install-deployment`,
      payload: { version: "0.1.0" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: "todo", version: "0.1.0" });
    const row = await db
      .selectFrom("plugin_installs")
      .selectAll()
      .where("name", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(row.directory_item_id).toBe(item.id);
    const missing = await admin({
      method: "POST",
      url: `/api/v1/admin/directory/items/${item.id}/install-deployment`,
      payload: { version: "9.9.9" },
    });
    expect(missing.statusCode).toBe(404);

    const skill = (await importFile(admin, await skillTgz())).json();
    const wrong = await admin({
      method: "POST",
      url: `/api/v1/admin/directory/items/${skill.id}/install-deployment`,
      payload: { version: "1.0.0" },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("directory.wrong_kind");
  });

  it("不合法的插件包被拒，什么都不写（F-AD）", async () => {
    await resetDirectory();
    const bad = await pluginTgz({ section: { entry: "dist/missing.mjs" } });
    const res = await importFile(admin, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("directory.invalid_package");
    await nothingStored();
  });

  it("与配置声明的插件重名被拒，什么都不写", async () => {
    const res = await importFile(admin, await pluginTgz({ name: "model-fake" }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.config_declared");
    await nothingStored();
  });
});

describe("应用、策略、删除与权限", () => {
  beforeAll(resetDirectory);

  it("应用包在 T25 之前返回 409 directory.wrong_kind", async () => {
    const res = await importFile(admin, await appTgz());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("directory.wrong_kind");
    await nothingStored();
  });

  it("改策略写审计；不合法的策略 400；删除后列表不显示（includeDeleted 才显示），名字可以重新导入", async () => {
    const item = (await importFile(admin, await skillTgz())).json();
    const put = await admin({
      method: "PUT",
      url: `/api/v1/admin/directory/items/${item.id}/policy`,
      payload: { policy: "needs_approval" },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().policy).toBe("needs_approval");
    const bad = await admin({
      method: "PUT",
      url: `/api/v1/admin/directory/items/${item.id}/policy`,
      payload: { policy: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "directory.policy_changed")
      .execute();
    expect(audit[0]?.detail).toMatchObject({ from: "allow", to: "needs_approval" });

    const del = await admin({ method: "DELETE", url: `/api/v1/admin/directory/items/${item.id}` });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await db
          .selectFrom("audit_events")
          .select("action")
          .where("action", "=", "directory.removed")
          .execute()
      ).length,
    ).toBe(1);
    const list = await admin({ method: "GET", url: "/api/v1/admin/directory/items" });
    expect(list.json().items).toEqual([]);
    const all = await admin({
      method: "GET",
      url: "/api/v1/admin/directory/items?includeDeleted=true",
    });
    expect(all.json().items).toHaveLength(1);
    const again = await admin({
      method: "DELETE",
      url: `/api/v1/admin/directory/items/${item.id}`,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("directory.item_not_found");
    const policyGone = await admin({
      method: "PUT",
      url: `/api/v1/admin/directory/items/${item.id}/policy`,
      payload: { policy: "allow" },
    });
    expect(policyGone.statusCode).toBe(404);
    const reimport = await importFile(admin, await skillTgz());
    expect(reimport.statusCode, reimport.body).toBe(201);
    expect(reimport.json().id).not.toBe(item.id);
  });

  it("不存在的条目 404", async () => {
    const res = await admin({
      method: "GET",
      url: "/api/v1/admin/directory/items/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("directory.item_not_found");
  });

  it("非企业管理员 403（读写都是）", async () => {
    const item = await db.selectFrom("directory_items").select("id").executeTakeFirstOrThrow();
    const calls = [
      importFile(member, await skillTgz({ version: "5.0.0" })),
      importNpm(member, { package: "@acme/skill-pdf-tools" }),
      member({ method: "GET", url: "/api/v1/admin/directory/items" }),
      member({ method: "GET", url: `/api/v1/admin/directory/items/${item.id}` }),
      member({
        method: "PUT",
        url: `/api/v1/admin/directory/items/${item.id}/policy`,
        payload: { policy: "disabled" },
      }),
      member({ method: "DELETE", url: `/api/v1/admin/directory/items/${item.id}` }),
      member({
        method: "POST",
        url: `/api/v1/admin/directory/items/${item.id}/install-deployment`,
        payload: { version: "1.0.0" },
      }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode, res.body).toBe(403);
    }
    // 上传先认证再读请求体：非企业管理员的超大请求体 403（不是 413）
    const huge = await importFile(member, new Uint8Array(MAX_BYTES * 2));
    expect(huge.statusCode, huge.body).toBe(403);
  });

  it("执行期复核：企业管理员身份在请求之后被撤销时写操作 403", async () => {
    const item = await db.selectFrom("directory_items").select("id").executeTakeFirstOrThrow();
    const svc = k.directory;
    const actor = memberId;
    await expect(svc.setPolicy(actor, item.id, "disabled")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(svc.importFile(actor, await skillTgz({ version: "6.0.0" }))).rejects.toMatchObject(
      {
        code: "forbidden",
      },
    );
    await expect(svc.remove(actor, item.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});
