import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeNpmRegistry,
  fakeExtensionEntry,
  npmProvenanceAttestations,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_STAGING_CLEANUP_JOB,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
} from "../../src/catalog/job-ids.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { legacyTgz, lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  bundlePlugin,
  mcpTemplate,
  SVG_ICON,
  skillPlugin,
  templateFiles,
  templatePlugin,
} from "./packages.js";

/**
 * Enterprise plugin import (phase 0b, spec §4.3): every plugin goes through prepare (the whole
 * plugin checked, staged with one review) and confirm (the item / version written, the extension's
 * snapshot approved, optionally deployed). Dependencies are resolved for the review, never fetched.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const CONNECTOR = fakeExtensionEntry("fake-connector");

const MAX_BYTES = 4 * 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let reg: FakeNpmRegistry;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let member: Req;
let adminId: string;

const pkgs: Record<string, Uint8Array> = {};

/** The plugin with every component: an extension, a skill, a connector template, two dependencies. */
const crm = (o: { version?: string; packageName?: string } = {}) =>
  bundlePlugin({
    name: "crm",
    ...(o.version !== undefined && { version: o.version }),
    packageName: o.packageName ?? "@acme/plugin-crm",
    skills: ["crm-notes"],
    templates: { "crm-mcp": mcpTemplate() },
    dependencies: [
      { name: "notes", version: "^1.0.0" },
      { name: "nowhere", version: "^2.0.0" },
    ],
    manifest: { icon: "./icon.svg", displayName: { zh: "CRM", en: "CRM" }, license: "MIT" },
    files: { "icon.svg": SVG_ICON, "README.md": "not stored\n" },
    extension: {},
  });

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  for (const [name, version] of [
    ["eps", "1.0.0"],
    ["eps", "1.1.0"],
    ["beta", "1.0.0"],
  ] as const) {
    pkgs[`${name}@${version}`] = await lifePkg({ name, version });
  }
  // zeta: 2.0.0 has no migrations, 1.0.0 has one (never run when downgrading to 1.0.0)
  pkgs["zeta@2.0.0"] = await lifePkg({ name: "zeta", version: "2.0.0" });
  pkgs["zeta@1.0.0"] = await lifePkg({
    name: "zeta",
    version: "1.0.0",
    migrations: [{ file: "0001_notes.sql", sql: "CREATE TABLE IF NOT EXISTS notes (id int);\n" }],
  });
  pkgs.npmSkills = await skillPlugin("npm-skills", { packageName: "@acme/plugin-npm-skills" });
  reg = await startFakeNpmRegistry({
    packages: [
      {
        name: "@acme/plugin-npm-skills",
        version: "1.0.0",
        tgz: pkgs.npmSkills,
        attestations: npmProvenanceAttestations({
          name: "@acme/plugin-npm-skills",
          version: "1.0.0",
          tgz: pkgs.npmSkills,
          repository: "https://github.com/acme/npm-skills",
          commit: "a".repeat(40),
        }),
      },
      // requested as @acme/other, but its package.json says @acme/plugin-npm-skills
      { name: "@acme/other", version: "1.0.0", tgz: pkgs.npmSkills },
    ],
  });
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-plugin-import-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES, npmRegistry: reg.url },
      marketplaces: { allowInsecureLoopback: true },
      extensions: [OBJECT_STORE, MODEL_FAKE, CONNECTOR],
      extensionConfig: {
        "fake-object-store": {
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
  const accounts = accountsFor(db);
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
  await reg?.stop();
  await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

async function reset(): Promise<void> {
  // Disable and uninstall what earlier cases put on the deployment (every replica unloads), then
  // clear the tables
  for (const r of await db.selectFrom("extension_installs").select("name").execute()) {
    await k.extensionAdminOps.disable(r.name, null);
    await k.extensionAdminOps.uninstall(r.name, null);
  }
  await truncateTables(
    db,
    "capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.extension_installs, capybara.extension_permission_snapshots, capybara.extension_name_owners, capybara.extension_blobs, capybara.extension_packages, capybara.audit_events",
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
const confirm = (req: Req, stagingId: string, body: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
    payload: body,
  });

interface Review {
  name: string;
  provenance?: unknown;
  version: string;
  pluginVersion?: string;
  contentDigest: string;
  extension?: {
    name: string;
    version: string;
    sha256: string;
    action: string;
    deployed: boolean;
    currentVersion: string | null;
    permissions: { category: string; sensitive: boolean; items: string[] }[];
    added: string[];
    sensitive: boolean;
  };
  skills: { name: string; description: string; body: string; path: string; files: number }[];
  connectorTemplates: { id: string; plugin: string; connector: string; endpoint: unknown }[];
  dependencies: { name: string; range: string; resolved: string | null }[];
  sensitive: boolean;
  reviewHash: string;
}

async function prepared(bytes: Uint8Array): Promise<{ stagingId: string; review: Review }> {
  const res = await prepareFile(admin, bytes);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** prepare -> confirm; returns the confirm response body. */
async function imported(bytes: Uint8Array, deployExtension = false) {
  const s = await prepared(bytes);
  const res = await confirm(admin, s.stagingId, {
    reviewHash: s.review.reviewHash,
    deployExtension,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function nothingStored(): Promise<void> {
  expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("catalog_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("extension_packages").select("sha256").execute()).toEqual([]);
  expect(await db.selectFrom("extension_permission_snapshots").select("plugin").execute()).toEqual(
    [],
  );
  expect((await k.storage.deployment().list("directory/")).items).toEqual([]);
}

describe("one import flow for every plugin", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("a skills-only plugin: staged with the skill's body, confirmed into an item with its files", async () => {
    const s = await prepared(
      await skillPlugin("pdf-tools", { skillMd: SKILL_MD("pdf-tools", "Read PDFs.") }),
    );
    expect(s.review).toMatchObject({
      name: "pdf-tools",
      version: "1.0.0",
      sensitive: false,
      connectorTemplates: [],
      dependencies: [],
      skills: [
        {
          name: "pdf-tools",
          description: "Read PDFs.",
          path: "./skills/pdf-tools",
          files: 2,
          body: expect.stringContaining("Steps."),
        },
      ],
    });
    expect(s.review.extension).toBeUndefined();
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().deploy).toBeNull();
    const item = res.json().item;
    expect(item).toMatchObject({
      name: "pdf-tools",
      publisher: "Acme",
      latestVersion: "1.0.0",
      source: "file",
    });
    expect(item.kind).toBeUndefined();
    const v = await db
      .selectFrom("catalog_item_versions")
      .selectAll()
      .where("item_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(v.extension_sha256).toBeNull();
    // The normalized manifest lists what was scanned
    expect(v.manifest).toMatchObject({
      name: "pdf-tools",
      skills: [{ path: "./skills/pdf-tools" }],
      connectorTemplates: [],
    });
    expect(v.files.map((f) => f.path).sort()).toEqual([
      "skills/pdf-tools/SKILL.md",
      "skills/pdf-tools/scripts/run.py",
    ]);
    const d = k.storage.deployment();
    expect(await d.head(`${v.object_prefix}skills/pdf-tools/SKILL.md`)).not.toBeNull();
  });

  it("a templates-only plugin: checked against the loaded connector, the template file and icon stored", async () => {
    const s = await prepared(await templatePlugin("github-mcp"));
    expect(s.review.connectorTemplates).toEqual([
      expect.objectContaining({
        id: "github-mcp",
        plugin: "fake-connector",
        connector: "fake",
        endpoint: { url: "https://mcp.example.com/mcp" },
        endpointChecked: true,
      }),
    ]);
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = await db
      .selectFrom("catalog_item_versions")
      .select(["files", "manifest"])
      .where("item_id", "=", res.json().item.id)
      .executeTakeFirstOrThrow();
    expect(v.files.map((f) => f.path).sort()).toEqual([
      "connectors/github-mcp.json",
      "icons/github-mcp.svg",
    ]);
    expect(v.manifest).toMatchObject({
      connectorTemplates: [{ path: "./connectors/github-mcp.json" }],
    });
  });

  it("an extension-only plugin: the package enters the store, confirm approves its snapshot, nothing in object storage", async () => {
    const bytes = await lifePkg({ name: "beta", version: "1.0.0" });
    const s = await prepared(bytes);
    expect(s.review.extension).toMatchObject({
      name: "beta",
      version: "1.0.0",
      sha256: sha256(bytes),
      action: "install",
      deployed: false,
      currentVersion: null,
      sensitive: true,
    });
    expect(s.review.extension?.permissions.find((g) => g.category === "tools")).toMatchObject({
      items: ["wait"],
    });
    const pkg = await db
      .selectFrom("extension_packages")
      .select(["name", "source"])
      .executeTakeFirstOrThrow();
    expect(pkg).toEqual({ name: "beta", source: "catalog" });
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = await db
      .selectFrom("catalog_item_versions")
      .select(["extension_sha256", "object_prefix", "files"])
      .where("item_id", "=", res.json().item.id)
      .executeTakeFirstOrThrow();
    expect(v).toEqual({ extension_sha256: sha256(bytes), object_prefix: null, files: [] });
    const snap = await db
      .selectFrom("extension_permission_snapshots")
      .select(["plugin", "version", "source", "approved_by"])
      .executeTakeFirstOrThrow();
    expect(snap).toEqual({ plugin: "beta", version: "1.0.0", source: "web", approved_by: adminId });
    // Not deployed without deployExtension
    expect(await db.selectFrom("extension_installs").select("name").execute()).toEqual([]);
  });

  it("a plugin with all three plus dependencies: resolved / unresolved in the review, unresolved does not block", async () => {
    // "notes" is in the catalog at 1.2.0 and 2.0.0; "nowhere" is not
    await imported(await skillPlugin("notes", { version: "1.2.0" }));
    await imported(await skillPlugin("notes", { version: "2.0.0" }));
    const bytes = await crm();
    const s = await prepared(bytes);
    expect(s.review.dependencies).toEqual([
      { name: "notes", range: "^1.0.0", resolved: "1.2.0" },
      { name: "nowhere", range: "^2.0.0", resolved: null },
    ]);
    expect(s.review).toMatchObject({
      name: "crm",
      license: "MIT",
      extension: { name: "crm", action: "install" },
      skills: [expect.objectContaining({ name: "crm-notes" })],
      connectorTemplates: [expect.objectContaining({ id: "crm-mcp" })],
    });
    const row = await db
      .selectFrom("plugin_import_staging")
      .selectAll()
      .where("id", "=", s.stagingId)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(adminId);
    const ttl = row.expires_at.getTime() - row.created_at.getTime();
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(60_000);
    const prefix = row.object_prefix as string;
    expect(prefix).toMatch(/^directory\/[0-9a-f-]{36}\/1\.0\.0\/[0-9a-f-]{36}\/$/);
    const d = k.storage.deployment();
    for (const f of ["icon.svg", "connectors/crm-mcp.json", "skills/crm-notes/SKILL.md"]) {
      expect(await d.head(`${prefix}${f}`), f).not.toBeNull();
    }
    for (const f of ["README.md", "package.json", "dist/index.mjs"]) {
      expect(await d.head(`${prefix}${f}`), f).toBeNull();
    }
    const staged = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "catalog.plugin_staged")
      .where("target", "=", s.stagingId)
      .executeTakeFirstOrThrow();
    expect(staged.detail).toMatchObject({
      name: "crm",
      version: "1.0.0",
      source: "file",
      reviewHash: s.review.reviewHash,
      extension: { sha256: sha256(bytes), action: "install" },
    });
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().item).toMatchObject({
      name: "crm",
      displayName: { zh: "CRM", en: "CRM" },
      latestVersion: "1.0.0",
    });
    const v = await db
      .selectFrom("catalog_item_versions")
      .selectAll()
      .where("item_id", "=", res.json().item.id)
      .executeTakeFirstOrThrow();
    expect(v.extension_sha256).toBe(sha256(bytes));
    expect(v.object_prefix).toBe(prefix);
    expect(v.manifest).toMatchObject({
      dependencies: [
        { name: "notes", version: "^1.0.0" },
        { name: "nowhere", version: "^2.0.0" },
      ],
    });
    // The staged review is gone once confirmed
    const gone = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/imports/${s.stagingId}`,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("plugin.staging_not_found");
    // Confirm works once
    const again = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("plugin.staging_not_found");
    // The admin detail shows the manifest per version
    const detail = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/items/${res.json().item.id}`,
    });
    expect(detail.json()).toMatchObject({
      hasIcon: true,
      versions: [{ version: "1.0.0", extensionSha256: sha256(bytes), manifest: { name: "crm" } }],
    });
  });

  it("a stale reviewHash is 409 plugin.review_stale and changes nothing", async () => {
    const s = await prepared(await skillPlugin("stale"));
    const res = await confirm(admin, s.stagingId, {
      reviewHash: "0".repeat(32),
      deployExtension: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.review_stale");
    expect(
      await db.selectFrom("catalog_items").select("id").where("name", "=", "stale").execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("plugin_import_staging")
        .select("id")
        .where("id", "=", s.stagingId)
        .execute(),
    ).toHaveLength(1);
  });

  it("a second version adds a version; the same version again is 409 catalog.version_exists", async () => {
    // the same content as the first case's import (other content would record 1.0.0+sha256.<12>)
    const dup = await prepareFile(
      admin,
      await skillPlugin("pdf-tools", { skillMd: SKILL_MD("pdf-tools", "Read PDFs.") }),
    );
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("catalog.version_exists");
    expect(dup.json().error.message).toContain("already imported with the same content");
    const r = await imported(await skillPlugin("pdf-tools", { version: "1.1.0" }));
    expect(r.item).toMatchObject({ latestVersion: "1.1.0", versions: ["1.1.0", "1.0.0"] });
    expect(
      await db.selectFrom("catalog_items").select("id").where("name", "=", "pdf-tools").execute(),
    ).toHaveLength(1);
  });

  it("other content at an imported version records <version>+sha256.<12>, the later import being the latest", async () => {
    const changed = await skillPlugin("pdf-tools", {
      version: "1.1.0",
      skillMd: SKILL_MD("pdf-tools", "Read PDFs, now faster."),
    });
    const s = await prepared(changed);
    const digest = (
      await db
        .selectFrom("plugin_import_staging")
        .select("manifest")
        .where("id", "=", s.stagingId)
        .executeTakeFirstOrThrow()
    ).manifest as { contentDigest: string };
    expect(digest.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    const recorded = `1.1.0+sha256.${digest.contentDigest.slice(0, 12)}`;
    expect(s.review).toMatchObject({
      version: recorded,
      pluginVersion: "1.1.0",
      contentDigest: digest.contentDigest,
    });
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().item).toMatchObject({
      latestVersion: recorded,
      versions: [recorded, "1.1.0", "1.0.0"],
    });
    const rows = await db
      .selectFrom("catalog_item_versions")
      .select(["version", "content_digest", "object_prefix"])
      .where("version", "like", "1.1.0%")
      .execute();
    expect(rows.find((r) => r.version === recorded)?.content_digest).toBe(digest.contentDigest);
    expect(rows.find((r) => r.version === "1.1.0")?.content_digest).toMatch(/^[0-9a-f]{64}$/);
    // `+` is not written into object keys
    expect(rows.find((r) => r.version === recorded)?.object_prefix).toContain(
      `/1.1.0_sha256.${digest.contentDigest.slice(0, 12)}/`,
    );
    // the same changed content again: already imported, under its recorded version
    const again = await prepareFile(admin, changed);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toMatchObject({
      code: "catalog.version_exists",
      message: `Version ${recorded} of this catalog item is already imported with the same content`,
    });
  });

  it("two staged imports of the same content: the second confirm is version_exists, asking to prepare again", async () => {
    const bytes = await skillPlugin("pdf-tools", { version: "3.0.0" });
    const a = await prepared(bytes);
    const b = await prepared(bytes);
    const ok = await confirm(admin, a.stagingId, {
      reviewHash: a.review.reviewHash,
      deployExtension: false,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const late = await confirm(admin, b.stagingId, {
      reviewHash: b.review.reviewHash,
      deployExtension: false,
    });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error.code).toBe("catalog.version_exists");
    expect(late.json().error.message).toContain("prepare the import again");
  });

  it("another npm package with the same plugin name is refused (catalog.name_conflict); so is an extension name owned by another package", async () => {
    const other = await prepareFile(
      admin,
      await skillPlugin("pdf-tools", { version: "9.0.0", packageName: "@evil/pdf" }),
    );
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("catalog.name_conflict");
    await db
      .insertInto("extension_name_owners")
      .values({ name: "owned", package_name: "@other/plugin-owned" })
      .execute();
    const owned = await prepareFile(
      admin,
      await pluginTgz({ manifest: { name: "owned" }, extension: {} }),
    );
    expect(owned.statusCode, owned.body).toBe(409);
    expect(owned.json().error.code).toBe("extension.name_conflict");
    await db.deleteFrom("extension_name_owners").where("name", "=", "owned").execute();
  });
});

describe("deployExtension", { timeout: 60_000 }, () => {
  beforeEach(reset);

  it("deploys only the plugin's own extension: installed and enabled without a restart", async () => {
    const r = await imported(await crm(), true);
    expect(r.deploy).toEqual(
      expect.objectContaining({ name: "crm", action: "install", result: "enabled" }),
    );
    const installs = await db
      .selectFrom("extension_installs")
      .select(["name", "version", "desired_state", "catalog_item_id"])
      .execute();
    expect(installs).toEqual([
      { name: "crm", version: "1.0.0", desired_state: "enabled", catalog_item_id: r.item.id },
    ]);
    expect(
      await db.selectFrom("extension_catalog_sources").select(["plugin", "item_id"]).execute(),
    ).toEqual([{ plugin: "crm", item_id: r.item.id }]);
    await waitFor(async () => k.host.current("crm")?.version === "1.0.0", 15_000, "crm");
  });

  it("an installed extension at another version is an upgrade; the same package is keep (no snapshot, no deploy)", async () => {
    const rv = await k.extensionInstalls.ingestFile(adminId, pkgs["eps@1.0.0"] as Uint8Array);
    await k.extensionAdminOps.install("eps", rv.sha256, adminId);
    const keep = await prepared(pkgs["eps@1.0.0"] as Uint8Array);
    expect(keep.review.extension).toMatchObject({
      action: "keep",
      deployed: true,
      currentVersion: "1.0.0",
    });
    const kept = await confirm(admin, keep.stagingId, {
      reviewHash: keep.review.reviewHash,
      deployExtension: true,
    });
    expect(kept.statusCode, kept.body).toBe(201);
    expect(kept.json().deploy).toBeNull();
    expect(
      await db.selectFrom("extension_permission_snapshots").select("plugin").execute(),
    ).toEqual([]);
    const up = await prepared(pkgs["eps@1.1.0"] as Uint8Array);
    expect(up.review.extension).toMatchObject({ action: "upgrade", currentVersion: "1.0.0" });
    const res = await confirm(admin, up.stagingId, {
      reviewHash: up.review.reviewHash,
      deployExtension: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().deploy).toMatchObject({ name: "eps", action: "upgrade", result: "enabled" });
    expect(res.json().item.versions).toEqual(["1.1.0", "1.0.0"]);
    await waitFor(async () => k.host.current("eps")?.version === "1.1.0", 15_000, "eps");
  });

  it("an upgrade that fails to install: the item is committed, the result says failed, the snapshot is restored", async () => {
    const rv = await k.extensionInstalls.ingestFile(adminId, pkgs["eps@1.0.0"] as Uint8Array);
    await k.extensionAdminOps.install("eps", rv.sha256, adminId);
    const view = await admin({ method: "GET", url: "/api/v1/admin/extensions/eps" });
    const approved = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/eps/approve",
      payload: { sha256: view.json().sha256, reviewHash: view.json().reviewHash },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const before = await db
      .selectFrom("extension_permission_snapshots")
      .selectAll()
      .where("plugin", "=", "eps")
      .executeTakeFirstOrThrow();
    const s = await prepared(pkgs["eps@1.1.0"] as Uint8Array);
    const spy = vi.spyOn(k.extensionAdminOps, "install").mockImplementation(async () => {
      throw new ApiError("extension.package_not_found", "simulated failure");
    });
    try {
      const res = await confirm(admin, s.stagingId, {
        reviewHash: s.review.reviewHash,
        deployExtension: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().deploy).toEqual(
        expect.objectContaining({
          name: "eps",
          action: "upgrade",
          result: "failed",
          code: "extension.package_not_found",
          sha256: sha256(pkgs["eps@1.1.0"] as Uint8Array),
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const after = await db
      .selectFrom("extension_permission_snapshots")
      .selectAll()
      .where("plugin", "=", "eps")
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const restored = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "extension.permissions_restored")
      .execute();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.detail).toMatchObject({ restoredVersion: "1.0.0" });
  });

  it("a downgrade to a version with unrun migrations is refused at prepare (409 extension.downgrade_unsupported), nothing written", async () => {
    const rv = await k.extensionInstalls.ingestFile(adminId, pkgs["zeta@2.0.0"] as Uint8Array);
    await k.extensionAdminOps.install("zeta", rv.sha256, adminId);
    const res = await prepareFile(admin, pkgs["zeta@1.0.0"] as Uint8Array);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("extension.downgrade_unsupported");
    expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
    expect(
      (await db.selectFrom("extension_packages").select("version").execute()).map((r) => r.version),
    ).toEqual(["2.0.0"]);
  });

  it("the migration state changes after prepare: confirm refuses the downgrade before writing", async () => {
    const rv = await k.extensionInstalls.ingestFile(adminId, pkgs["zeta@2.0.0"] as Uint8Array);
    await k.extensionAdminOps.install("zeta", rv.sha256, adminId);
    const migrationSql = "CREATE TABLE IF NOT EXISTS notes (id int);\n";
    await sql`CREATE SCHEMA IF NOT EXISTS plugin_zeta`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS plugin_zeta._migrations (name text PRIMARY KEY, checksum text NOT NULL)`.execute(
      db,
    );
    await sql`INSERT INTO plugin_zeta._migrations VALUES ('0001_notes.sql', ${createHash("sha256").update(migrationSql).digest("hex")})`.execute(
      db,
    );
    try {
      const s = await prepared(pkgs["zeta@1.0.0"] as Uint8Array);
      expect(s.review.extension).toMatchObject({ action: "upgrade", currentVersion: "2.0.0" });
      await sql`DELETE FROM plugin_zeta._migrations`.execute(db);
      const res = await confirm(admin, s.stagingId, {
        reviewHash: s.review.reviewHash,
        deployExtension: true,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("extension.downgrade_unsupported");
      expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toHaveLength(1);
      expect(await db.selectFrom("catalog_items").select("id").execute()).toEqual([]);
    } finally {
      await sql`DROP SCHEMA IF EXISTS plugin_zeta CASCADE`.execute(db);
    }
  });

  it("the extension gets installed by someone else after the review -> plugin.review_stale", async () => {
    const s = await prepared(pkgs["beta@1.0.0"] as Uint8Array);
    expect(s.review.extension?.action).toBe("install");
    const rv = await k.extensionInstalls.ingestFile(adminId, pkgs["beta@1.0.0"] as Uint8Array);
    await k.extensionAdminOps.install("beta", rv.sha256, adminId);
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plugin.review_stale");
  });
});

describe("invalid plugins: nothing is written", { timeout: 60_000 }, () => {
  beforeEach(reset);

  it("a pre-0.1.0 tgz (capybara section or app.yaml) is 422 catalog.legacy_format with the repack message", async () => {
    for (const bytes of [await legacyTgz(), await legacyTgz({ appYaml: true })]) {
      const res = await prepareFile(admin, bytes);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe("catalog.legacy_format");
      expect(res.json().error.message).toMatch(
        /uses the pre-0\.1\.0 package format \(capybara section \/ app\.yaml\); repack it as a plugin with \.capybara-plugin\/plugin\.json \(pnpm pack-plugin\)/,
      );
    }
    await nothingStored();
  });

  it("an invalid skill, template, icon or extension entry is 422 catalog.invalid_manifest naming the path", async () => {
    const cases: [string, Uint8Array, RegExp][] = [
      [
        "skill",
        await skillPlugin("bad-skill", { skillMd: "no frontmatter" }),
        /skills\/bad-skill\/SKILL\.md/,
      ],
      [
        "endpoint",
        await templatePlugin(
          "bad-ep",
          mcpTemplate({ endpoint: { url: "http://insecure.example/mcp" } }),
        ),
        /connectors\/bad-ep\.json: template\.endpoint/,
      ],
      [
        "editable",
        await templatePlugin("bad-edit", mcpTemplate({ editableEndpoint: ["url", "baseUrl"] })),
        /baseUrl/,
      ],
      [
        "credential",
        await templatePlugin(
          "bad-cred",
          mcpTemplate({ auth: { type: "bearer", token: "s3cr3t" } }),
        ),
        /connectors\/bad-cred\.json/,
      ],
      [
        "connector",
        await templatePlugin("nowhere", mcpTemplate({ plugin: "connector-nowhere" })),
        /connector-nowhere/,
      ],
      [
        "icon",
        await templatePlugin("bad-icon", mcpTemplate(), { icon: "not an svg" }),
        /icons\/bad-icon\.svg is not an SVG document/,
      ],
      [
        "entry",
        await pluginTgz({
          manifest: { name: "demo-pkg" },
          extension: { section: { entry: "./dist/missing.mjs" } },
        }),
        /extension\.entry: \.\/dist\/missing\.mjs not found/,
      ],
    ];
    for (const [label, bytes, re] of cases) {
      const res = await prepareFile(admin, bytes);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(422);
      expect(res.json().error.code, label).toBe("catalog.invalid_manifest");
      expect(JSON.stringify(res.json().error), label).toMatch(re);
      expect(res.body, label).not.toMatch(/s3cr3t/);
    }
    await nothingStored();
  });

  it("a template whose connector is the plugin's own extension or a dependency's is checked statically", async () => {
    const own = bundlePlugin({
      name: "own-conn",
      templates: { gh: mcpTemplate({ plugin: "own-conn", connector: "own" }) },
      extension: {},
    });
    const dep = bundlePlugin({
      name: "dep-conn",
      dependencies: [{ name: "some-connector", version: "^1.0.0" }],
      templates: { gh: mcpTemplate({ plugin: "some-connector", connector: "x" }) },
    });
    for (const bytes of [await own, await dep]) {
      const s = await prepared(bytes);
      expect(s.review.connectorTemplates[0]).toMatchObject({ endpointChecked: false });
    }
  });

  it("a declarative plugin cannot take a config-declared extension's name, nor one owned by another package", async () => {
    const declared = await prepareFile(admin, await skillPlugin("model-fake"));
    expect(declared.statusCode, declared.body).toBe(409);
    expect(declared.json().error.code).toBe("extension.config_declared");
    await db
      .insertInto("extension_name_owners")
      .values({ name: "owned-name", package_name: "@other/plugin-owned-name" })
      .execute();
    try {
      const owned = await prepareFile(admin, await skillPlugin("owned-name"));
      expect(owned.statusCode, owned.body).toBe(409);
      expect(owned.json().error.code).toBe("extension.name_conflict");
    } finally {
      await db.deleteFrom("extension_name_owners").where("name", "=", "owned-name").execute();
    }
    await nothingStored();
  });

  it("an extension named like a config-declared one is 409 extension.config_declared", async () => {
    const res = await prepareFile(
      admin,
      await pluginTgz({ manifest: { name: "model-fake" }, extension: {} }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("extension.config_declared");
    await nothingStored();
  });

  it("an invalid template icon among several templates is named by its path", async () => {
    const bytes = await bundlePlugin({
      name: "many",
      files: {
        ...templateFiles("a", mcpTemplate({ plugin: "connector-nowhere" })),
        ...templateFiles("b", mcpTemplate(), { icon: "<html/>" }),
      },
    });
    const res = await prepareFile(admin, bytes);
    expect(res.statusCode).toBe(422);
    const details = JSON.stringify(res.json().error.details);
    expect(details).toMatch(/icons\/b\.svg/);
    await nothingStored();
  });
});

describe("npm source", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("import/npm: downloaded by dist.integrity, staged with source npm; the version records it", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/npm",
      payload: { package: "@acme/plugin-npm-skills" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    expect(s.review.name).toBe("npm-skills");
    // npm provenance is shown with the review (spec §5.5)
    expect(s.review.provenance).toEqual({
      checked: true,
      repository: "https://github.com/acme/npm-skills",
      commit: "a".repeat(40),
      workflow: ".github/workflows/release.yml",
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    });
    expect(s.review.provenanceWarning).toBeUndefined();
    const c = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(c.statusCode, c.body).toBe(201);
    const v = await db
      .selectFrom("catalog_item_versions")
      .select(["source", "source_ref", "integrity"])
      .where("item_id", "=", c.json().item.id)
      .executeTakeFirstOrThrow();
    expect(v).toEqual({
      source: "npm",
      source_ref: "@acme/plugin-npm-skills@1.0.0",
      integrity: sri(pkgs.npmSkills as Uint8Array),
    });
  });

  it("a package whose package.json name differs from the requested one is 422 catalog.invalid_manifest", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/npm",
      payload: { package: "@acme/other" },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("catalog.invalid_manifest");
    expect(res.json().error.message).toMatch(/@acme\/other/);
  });
});

describe("staging cleanup (maintenance job app-staging-cleanup)", { timeout: 60_000 }, () => {
  beforeAll(reset);

  it("GET imports/:stagingId returns the staged review; unknown and expired ones are 404", async () => {
    const s = await prepared(await skillPlugin("readable"));
    const res = await admin({ method: "GET", url: `/api/v1/admin/catalog/imports/${s.stagingId}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stagingId: s.stagingId, review: s.review });
    // an upload is not an npm package: provenance not checked
    expect(s.review.provenance).toEqual({ checked: false, reason: "not an npm package" });
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const missing = await admin({ method: "GET", url: `/api/v1/admin/catalog/imports/${id}` });
      expect(missing.statusCode, id).toBe(404);
      expect(missing.json().error.code).toBe("plugin.staging_not_found");
    }
    await db
      .updateTable("plugin_import_staging")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` as unknown as Date })
      .where("id", "=", s.stagingId)
      .execute();
    const expired = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/imports/${s.stagingId}`,
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.code).toBe("plugin.staging_not_found");
    // Leave nothing for the cleanup case below
    expect(await k.pluginImport.cleanupExpired()).toBe(1);
  });

  it("an expired staging is 404 on confirm; cleanup deletes the row and the object prefix", async () => {
    const s = await prepared(await skillPlugin("expiring"));
    const row = await db
      .selectFrom("plugin_import_staging")
      .select("object_prefix")
      .where("id", "=", s.stagingId)
      .executeTakeFirstOrThrow();
    const prefix = row.object_prefix as string;
    expect((await k.storage.deployment().list(prefix)).items.length).toBeGreaterThan(0);
    await db
      .updateTable("plugin_import_staging")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` as unknown as Date })
      .execute();
    const res = await confirm(admin, s.stagingId, {
      reviewHash: s.review.reviewHash,
      deployExtension: false,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("plugin.staging_not_found");
    expect(await k.pluginImport.cleanupExpired()).toBe(1);
    expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
    expect((await k.storage.deployment().list(prefix)).items).toEqual([]);
  });

  it("the job name and scheduler id contain no colon", () => {
    expect(PLUGIN_STAGING_CLEANUP_JOB).toBe("app-staging-cleanup");
    expect(PLUGIN_STAGING_CLEANUP_SCHEDULER_ID).not.toContain(":");
  });
});

describe("permissions", { timeout: 60_000 }, () => {
  it("non enterprise admins get 403 on the four endpoints", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const res of [
      await prepareFile(member, await skillPlugin("x")),
      await member({
        method: "POST",
        url: "/api/v1/admin/catalog/import/npm",
        payload: { package: "@acme/plugin-npm-skills" },
      }),
      await confirm(member, id, { reviewHash: "x", deployExtension: false }),
      await member({ method: "GET", url: `/api/v1/admin/catalog/imports/${id}` }),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
  });

  it("the old routes are gone", async () => {
    for (const url of [
      "/api/v1/admin/catalog/plugins/prepare/npm",
      "/api/v1/admin/catalog/plugins/00000000-0000-4000-8000-000000000000/confirm",
    ]) {
      const res = await admin({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
