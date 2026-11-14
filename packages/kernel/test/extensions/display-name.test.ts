import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionDisplayNames } from "../../src/extensions/display-name.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

const FAKE_MODEL = { zh: "模拟模型", en: "Fake model" };
const MIGRATION = "0066_extension_display_name.sql";

/** 0066: `extension_packages.display_name` is added to a database that already has packages. */
describe("migration 0066_extension_display_name", () => {
  let pg: TestContainer;
  let raw: ReturnType<typeof createDb>;
  let before: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    raw = createDb(pg.url, 2);
    before = mkdtempSync(join(tmpdir(), "cap-mig-"));
    for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < MIGRATION) {
        copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(before, f));
      }
    }
  });

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await raw?.destroy();
    await pg?.stop();
  });

  it("applies on existing extension_packages rows (the column is null), and runs again as a no-op", async () => {
    await migrate(pg.url, { schema: "capybara", dir: before });
    await sql`insert into capybara.extension_packages
      (sha256, name, package_name, version, size, section, blob_store, source, source_ref)
      values (${"c".repeat(64)}, 'old', '@x/old', '1.0.0', 1, '{}', 'pg', 'file', 'upload')`.execute(
      raw,
    );
    const { applied } = await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    expect(applied).toContain(MIGRATION);
    const rows = await sql<{
      display_name: unknown;
    }>`select display_name from capybara.extension_packages where name = 'old'`.execute(raw);
    expect(rows.rows).toEqual([{ display_name: null }]);
    const again = await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    expect(again.applied).toEqual([]);
  });
});

/** Extension display names (extension config forms spec §2): stored, resolved, served by every API. */
describe("extension display names", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let db: KernelSchemaDb;
  let destroyDb: () => Promise<void>;
  let k: TestKernel | undefined;
  let admin: Req;
  let orgId: string;

  const upload = async (bytes: Uint8Array) => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/packages/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { sha256: string; name: string };
  };

  const liveItem = (name: string, displayName: { zh: string; en: string } | null) =>
    db
      .insertInto("catalog_items")
      .values({
        id: randomUUID(),
        name,
        package_name: `@acme/plugin-${name}`,
        publisher: "Acme",
        display_name: displayName === null ? null : JSON.stringify(displayName),
        description: "Test",
        latest_version: "1.0.0",
      })
      .execute();

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const raw = createDb(pgc.url, 3);
    db = kernelDb(raw);
    destroyDb = () => raw.destroy();
    await truncateTables(
      db,
      "capybara.catalog_items, capybara.extension_installs, capybara.extension_packages, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
    );
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      superAdmin: true,
    });
    k = await startKernel(
      resolveConfig(
        {
          db: { url: pgc.url, poolMax: 5 },
          redis: { url: rd.url },
          masterKey: Buffer.alloc(32, 7).toString("base64"),
          marketplaces: { official: { enabled: false } },
          http: { port: 0 },
          roles: ["api", "worker"],
          extensions: [MODEL_FAKE],
          extensionPermissions: { autoApprove: true },
          extensionConfig: { "model-fake": { models: [{ id: "fake-1" }] } },
        },
        {},
      ),
    );
    admin = await session(k, "root");
    orgId = await createOrg(admin);
  });

  afterAll(async () => {
    await k?.close();
    await destroyDb?.();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  it("ingest stores plugin.json displayName (null without one); the admin view serves it", async () => {
    const named = await upload(
      await pluginTgz({
        manifest: { name: "named-ext", displayName: { zh: "命名扩展", en: "Named extension" } },
        extension: {},
      }),
    );
    const plain = await upload(await pluginTgz({ manifest: { name: "plain-ext" }, extension: {} }));
    const rows = await db
      .selectFrom("extension_packages")
      .select(["sha256", "display_name"])
      .where("sha256", "in", [named.sha256, plain.sha256])
      .execute();
    expect(rows.find((r) => r.sha256 === named.sha256)?.display_name).toEqual({
      zh: "命名扩展",
      en: "Named extension",
    });
    expect(rows.find((r) => r.sha256 === plain.sha256)?.display_name).toBeNull();

    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/named-ext/install",
      payload: { sha256: named.sha256 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      name: "named-ext",
      displayName: { zh: "命名扩展", en: "Named extension" },
    });
  });

  it("the resolver: installed package, else the live catalog item, else null (one query for many)", async () => {
    const plain = await upload(
      await pluginTgz({ manifest: { name: "fallback-ext" }, extension: {} }),
    );
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/fallback-ext/install",
      payload: { sha256: plain.sha256 },
    });
    expect(res.statusCode, res.body).toBe(200);
    await liveItem("fallback-ext", { zh: "目录名", en: "Catalog name" });
    await liveItem("catalog-only", { zh: "仅目录", en: "Catalog only" });
    // a deleted item is not the live one
    await db
      .insertInto("catalog_items")
      .values({
        id: randomUUID(),
        name: "gone-ext",
        package_name: "@acme/plugin-gone-ext",
        publisher: "Acme",
        display_name: JSON.stringify({ zh: "已删", en: "Gone" }),
        description: "Test",
        latest_version: "1.0.0",
        deleted_at: new Date(),
      })
      .execute();
    const names = k?.app.get(ExtensionDisplayNames) as ExtensionDisplayNames;
    const many = await names.many([
      "model-fake",
      "fallback-ext",
      "catalog-only",
      "gone-ext",
      "unknown-ext",
    ]);
    expect(Object.fromEntries(many)).toEqual({
      "model-fake": FAKE_MODEL,
      "fallback-ext": { zh: "目录名", en: "Catalog name" },
      "catalog-only": { zh: "仅目录", en: "Catalog only" },
      "gone-ext": null,
      "unknown-ext": null,
    });
    expect(await names.get("catalog-only")).toEqual({ zh: "仅目录", en: "Catalog only" });
    expect(await names.get("unknown-ext")).toBeNull();
    expect((await names.many([])).size).toBe(0);
  });

  it("the admin list and detail: a config-declared extension reads its directory's plugin.json", async () => {
    const list = await admin({ method: "GET", url: "/api/v1/admin/extensions" });
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json() as { extensions: { name: string; displayName: unknown }[] })
      .extensions;
    expect(items.find((e) => e.name === "model-fake")?.displayName).toEqual(FAKE_MODEL);
    expect(items.every((e) => e.displayName !== undefined)).toBe(true);
    const one = await admin({ method: "GET", url: "/api/v1/admin/extensions/model-fake" });
    expect(one.json()).toMatchObject({ displayName: FAKE_MODEL });
  });

  it("the deployment config view", async () => {
    const res = await admin({ method: "GET", url: "/api/v1/admin/extensions/model-fake/config" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ plugin: "model-fake", displayName: FAKE_MODEL });
  });

  it("the org extension list (also the channel plugin options)", async () => {
    const res = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { extensions: { plugin: string; displayName: unknown }[] })
      .extensions;
    expect(items.find((e) => e.plugin === "model-fake")?.displayName).toEqual(FAKE_MODEL);
    expect(items.find((e) => e.plugin === "named-ext")?.displayName).toEqual({
      zh: "命名扩展",
      en: "Named extension",
    });
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/model-fake`,
      payload: { enabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      extension: { plugin: "model-fake", displayName: FAKE_MODEL },
    });
  });

  it("the models lists: providers[].displayName", async () => {
    const org = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/models` });
    expect(org.statusCode, org.body).toBe(200);
    expect(org.json()).toMatchObject({
      providers: [{ provider: "model-fake", displayName: FAKE_MODEL }],
    });
    const adm = await admin({ method: "GET", url: "/api/v1/admin/models" });
    expect(adm.statusCode, adm.body).toBe(200);
    expect(adm.json()).toMatchObject({
      providers: [{ provider: "model-fake", displayName: FAKE_MODEL }],
    });
  });
});
