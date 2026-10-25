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
import { legacyTgz, packOfficialPlugin } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";
import { skillPlugin } from "./packages.js";

/**
 * The enterprise catalog's items (one kind: every item is a plugin): list and detail, policy,
 * delete, installing an item's extension on the deployment, and the import entry points that are
 * not about the review itself (plugin-import.test.ts covers the review).
 */

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
let adminId: string;

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
        name: "@acme/plugin-pdf-tools",
        version: "2.0.0",
        tgz: await skillPlugin("pdf-tools", { version: "2.0.0" }),
      },
      {
        name: "@acme/plugin-tampered",
        version: "1.0.0",
        tgz: await skillPlugin("tampered"),
        integrity: sri(new Uint8Array(1)),
      },
      {
        name: "@acme/plugin-legacy",
        version: "1.0.0",
        tgz: await legacyTgz({ packageName: "@acme/plugin-legacy" }),
      },
    ],
  });
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES, npmRegistry: reg.url },
      extensions: [S3_PLUGIN, MODEL_FAKE, CONNECTOR_MCP],
      extensionConfig: {
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
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  admin = await session(k, "root");
  member = await session(k, "mem");
  // Warm up storage: a fresh SeaweedFS sometimes takes seconds for its first write (volume
  // allocation); keep that out of the first case's time limit
  const warm = new TextEncoder().encode("warm");
  await k.storage
    .deployment()
    .put("warmup/probe", warm, { contentType: "text/plain", size: warm.byteLength });
  await k.storage.deployment().delete("warmup/probe");
}, 240_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await reg?.stop();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

async function resetCatalog(): Promise<void> {
  await truncateTables(
    db,
    "capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.audit_events",
  );
  await k.storage.deployment().deletePrefix("directory/");
}

const prepareFile = (req: Req, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
const prepareNpm = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/admin/catalog/import/npm", payload: body });
const confirm = (req: Req, stagingId: string, reviewHash: string) =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
    payload: { reviewHash, deployExtension: false },
  });

/** prepare (file or npm response) -> confirm; returns the item. */
async function confirmed(prepared: Awaited<ReturnType<Req>>) {
  expect(prepared.statusCode, prepared.body).toBe(200);
  const s = prepared.json();
  const res = await confirm(admin, s.stagingId, s.review.reviewHash);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().item;
}

const importFile = async (bytes: Uint8Array) => confirmed(await prepareFile(admin, bytes));

async function nothingStored(): Promise<void> {
  expect(await db.selectFrom("catalog_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("catalog_item_versions").select("item_id").execute()).toEqual([]);
  expect(await db.selectFrom("extension_packages").select("sha256").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
  expect((await k.storage.deployment().list("directory/")).items).toEqual([]);
}

describe("items", () => {
  beforeAll(resetCatalog);

  it("an import creates the item with its listing fields and audits catalog.imported", async () => {
    const item = await importFile(await skillPlugin("pdf-tools"));
    expect(item).toMatchObject({
      name: "pdf-tools",
      publisher: "Acme",
      displayName: null,
      description: "pdf-tools plugin",
      policy: "allow",
      latestVersion: "1.0.0",
      versions: ["1.0.0"],
      installs: 0,
      source: "file",
    });
    const audit = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "catalog.imported")
      .execute();
    expect(audit).toEqual([
      {
        target: item.id,
        detail: expect.objectContaining({ name: "pdf-tools", version: "1.0.0", source: "file" }),
      },
    ]);
    expect(audit[0]?.detail).not.toHaveProperty("kind");
  }, 20_000);

  it("from npm: source npm with the integrity; a mismatching integrity is 502 and writes nothing", async () => {
    const item = await confirmed(
      await prepareNpm(admin, { package: "@acme/plugin-pdf-tools", version: "2.0.0" }),
    );
    expect(item).toMatchObject({ latestVersion: "2.0.0", source: "npm" });
    const v = await db
      .selectFrom("catalog_item_versions")
      .select(["source", "source_ref", "integrity"])
      .where("version", "=", "2.0.0")
      .executeTakeFirstOrThrow();
    expect(v).toMatchObject({ source: "npm", source_ref: "@acme/plugin-pdf-tools@2.0.0" });
    expect(v.integrity).toMatch(/^sha512-/);
    const before = await db.selectFrom("catalog_item_versions").select("version").execute();
    const bad = await prepareNpm(admin, { package: "@acme/plugin-tampered" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.code).toBe("packages.npm_failed");
    expect(await db.selectFrom("catalog_item_versions").select("version").execute()).toEqual(
      before,
    );
  });

  it("a pre-0.1.0 package from npm is 422 catalog.legacy_format", async () => {
    const res = await prepareNpm(admin, { package: "@acme/plugin-legacy" });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("catalog.legacy_format");
    expect(res.json().error.message).toMatch(/^Package @acme\/plugin-legacy uses the pre-0\.1\.0/);
  });

  it("concurrent confirms of the same version: one 201, one 409, distinct prefixes, the winner's files intact", async () => {
    const a = await skillPlugin("pdf-tools", {
      version: "3.0.0",
      files: { "skills/pdf-tools/a.txt": "A".repeat(4096) },
    });
    const b = await skillPlugin("pdf-tools", {
      version: "3.0.0",
      files: { "skills/pdf-tools/a.txt": "B".repeat(4096) },
    });
    const [pa, pb] = await Promise.all([prepareFile(admin, a), prepareFile(admin, b)]);
    expect([pa.statusCode, pb.statusCode]).toEqual([200, 200]);
    const res = await Promise.all(
      [pa, pb].map((p) => confirm(admin, p.json().stagingId, p.json().review.reviewHash)),
    );
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.statusCode === 409)?.json().error.code).toBe("catalog.version_exists");
    const prefixes = new Set(
      (await k.storage.deployment().list("directory/")).items
        .map((i) => i.key)
        .filter((key) => key.includes("/3.0.0/"))
        .map((key) => key.split("/").slice(0, 4).join("/")),
    );
    expect(prefixes.size).toBe(2);
    const v = await db
      .selectFrom("catalog_item_versions")
      .selectAll()
      .where("version", "=", "3.0.0")
      .executeTakeFirstOrThrow();
    const d = k.storage.deployment();
    for (const f of v.files) {
      const got = await d.get(`${v.object_prefix}${f.path}`);
      expect(got, f.path).not.toBeNull();
      const bytes = new Uint8Array(await new Response(got?.body).arrayBuffer());
      expect(sha256(bytes), f.path).toBe(f.sha256);
    }
  });

  it("list paging: limit / offset, nextOffset points at the next page", async () => {
    await importFile(await skillPlugin("b-skill"));
    const p1 = await admin({ method: "GET", url: "/api/v1/admin/catalog/items?limit=1" });
    expect(p1.statusCode, p1.body).toBe(200);
    expect(p1.json().items).toHaveLength(1);
    expect(p1.json().nextOffset).toBe(1);
    const p2 = await admin({
      method: "GET",
      url: "/api/v1/admin/catalog/items?limit=1&offset=1",
    });
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().items[0].id).not.toBe(p1.json().items[0].id);
    expect(p2.json().nextOffset).toBeNull();
    const bad = await admin({ method: "GET", url: "/api/v1/admin/catalog/items?limit=5000" });
    expect(bad.statusCode).toBe(400);
  });

  it("the detail has every version with its manifest", async () => {
    const id = (
      await db
        .selectFrom("catalog_items")
        .select("id")
        .where("name", "=", "pdf-tools")
        .executeTakeFirstOrThrow()
    ).id;
    const res = await admin({ method: "GET", url: `/api/v1/admin/catalog/items/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json();
    expect(detail.item.versions).toEqual(["3.0.0", "2.0.0", "1.0.0"]);
    expect(detail.versions[1]).toMatchObject({ version: "2.0.0", source: "npm" });
    expect(detail.versions[0].manifest).toMatchObject({
      name: "pdf-tools",
      skills: [{ path: "./skills/pdf-tools" }],
    });
    expect(detail.hasIcon).toBe(false);
  });
});

describe("installing an item's extension on the deployment", () => {
  beforeAll(resetCatalog);

  it("calls the extension install, the install records the item; a version without an extension is 409 catalog.no_extension", async () => {
    const item = await importFile(todo);
    expect(item).toMatchObject({ name: "todo", latestVersion: "0.1.0" });
    const pkg = await db
      .selectFrom("extension_packages")
      .selectAll()
      .where("sha256", "=", sha256(todo))
      .executeTakeFirstOrThrow();
    expect(pkg).toMatchObject({ source: "catalog", source_ref: `${item.id}@0.1.0` });
    const res = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${item.id}/install-deployment`,
      payload: { version: "0.1.0" },
    });
    expect(res.statusCode, res.body).toBe(200);
    // The import's review approved the permissions
    expect(res.json()).toMatchObject({ name: "todo", version: "0.1.0", status: "disabled" });
    const row = await db
      .selectFrom("extension_installs")
      .selectAll()
      .where("name", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(row.catalog_item_id).toBe(item.id);
    expect(
      await db
        .selectFrom("extension_catalog_sources")
        .selectAll()
        .where("plugin", "=", "todo")
        .execute(),
    ).toMatchObject([{ plugin: "todo", item_id: item.id }]);
    // Reinstalling the same package outside the catalog keeps the source item
    await k.extensionAdminOps.install("todo", sha256(todo), adminId);
    const kept = await db
      .selectFrom("extension_installs")
      .select("catalog_item_id")
      .where("name", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(kept.catalog_item_id).toBe(item.id);
    const missing = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${item.id}/install-deployment`,
      payload: { version: "9.9.9" },
    });
    expect(missing.statusCode).toBe(404);

    const skill = await importFile(await skillPlugin("pdf-tools"));
    const none = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${skill.id}/install-deployment`,
      payload: { version: "1.0.0" },
    });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("catalog.no_extension");
  });

  it("importing the same todo version from npm is 409 catalog.version_exists", async () => {
    const res = await prepareNpm(admin, { package: "@capybara-hq/plugin-todo" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("catalog.version_exists");
  });
});

describe("policy, delete and permissions", () => {
  beforeAll(resetCatalog);

  it("the policy change is audited; a bad policy is 400; a deleted item is hidden and the name can be imported again", async () => {
    const item = await importFile(await skillPlugin("pdf-tools"));
    const put = await admin({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${item.id}/policy`,
      payload: { policy: "needs_approval" },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().policy).toBe("needs_approval");
    const bad = await admin({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${item.id}/policy`,
      payload: { policy: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "catalog.policy_changed")
      .execute();
    expect(audit[0]?.detail).toEqual({ name: "pdf-tools", from: "allow", to: "needs_approval" });

    const del = await admin({ method: "DELETE", url: `/api/v1/admin/catalog/items/${item.id}` });
    expect(del.statusCode).toBe(204);
    const list = await admin({ method: "GET", url: "/api/v1/admin/catalog/items" });
    expect(list.json().items).toEqual([]);
    const all = await admin({
      method: "GET",
      url: "/api/v1/admin/catalog/items?includeDeleted=true",
    });
    expect(all.json().items).toHaveLength(1);
    const again = await admin({ method: "DELETE", url: `/api/v1/admin/catalog/items/${item.id}` });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("catalog.item_not_found");
    const reimport = await importFile(await skillPlugin("pdf-tools"));
    expect(reimport.id).not.toBe(item.id);
  });

  it("a missing item is 404", async () => {
    const res = await admin({
      method: "GET",
      url: "/api/v1/admin/catalog/items/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("catalog.item_not_found");
  });

  it("non enterprise admins get 403 (reads and writes)", async () => {
    const item = await db.selectFrom("catalog_items").select("id").executeTakeFirstOrThrow();
    const calls = [
      prepareFile(member, await skillPlugin("x", { version: "5.0.0" })),
      prepareNpm(member, { package: "@acme/plugin-pdf-tools" }),
      member({ method: "GET", url: "/api/v1/admin/catalog/items" }),
      member({ method: "GET", url: `/api/v1/admin/catalog/items/${item.id}` }),
      member({
        method: "PUT",
        url: `/api/v1/admin/catalog/items/${item.id}/policy`,
        payload: { policy: "disabled" },
      }),
      member({ method: "DELETE", url: `/api/v1/admin/catalog/items/${item.id}` }),
      member({
        method: "POST",
        url: `/api/v1/admin/catalog/items/${item.id}/install-deployment`,
        payload: { version: "1.0.0" },
      }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode, res.body).toBe(403);
    }
    // Uploads authenticate before reading the body: a huge body from a non admin is 403, not 413
    const huge = await prepareFile(member, new Uint8Array(MAX_BYTES * 2));
    expect(huge.statusCode, huge.body).toBe(403);
  });

  it("re-checked when run: an actor no longer an enterprise admin gets forbidden on writes", async () => {
    const item = await db.selectFrom("catalog_items").select("id").executeTakeFirstOrThrow();
    await expect(k.catalog.setPolicy(memberId, item.id, "disabled")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      k.pluginImport.prepare(memberId, await skillPlugin("y", { version: "6.0.0" }), {
        kind: "file",
        ref: "upload",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(k.catalog.remove(memberId, item.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a rejected import writes nothing", async () => {
    await resetCatalog();
    const res = await prepareFile(admin, await skillPlugin("bad", { skillMd: "no frontmatter" }));
    expect(res.statusCode).toBe(422);
    await nothingStored();
  });
});
