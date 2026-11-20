import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapExtraManifest, BootstrapGitEntry } from "@capybara-hq/plugin-sdk";
import {
  type FakeGitServer,
  fakeExtensionEntry,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketplacesService } from "../../src/catalog/marketplaces.service.js";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { BootstrapService, resolveBootstrapPackages } from "../../src/extensions/bootstrap.js";
import {
  type MergedBootstrapManifest,
  mergeBootstrapManifests,
} from "../../src/extensions/bootstrap-extra.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { packPackageTgz, unpackPackageTgz } from "../../src/packages/tgz.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

// Git entries of the extra bootstrap manifest (spec 2026-11-20-bootstrap-extra-manifest §4): the
// tree at the pinned commit, verified against the kernel's pack, credentials only to the
// marketplace's origin, and recorded as the managed marketplace's source.

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const TOKEN = "bootstrap-git-s3cret-token";
const WRONG = "bootstrap-git-wrong-token";
const USER = "x-token-auth";

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
/** The public distribution repo `dist` (also a git marketplace listing theme-x). */
let srv: FakeGitServer;
/** A private repo (Basic auth with TOKEN), another origin. */
let priv: FakeGitServer;
let pluginsDir: string;
let offlineDir: string;
let config: KernelConfig;
let k: TestKernel;
let admin: Req;

const enc = (s: string) => new TextEncoder().encode(s);
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
/** The kernel's canonical pack of a tree (what an entry's integrity is defined on). */
const packOf = (files: Record<string, string>) =>
  packPackageTgz(new Map(Object.entries(files).map(([p, d]) => [p, enc(d)])));
const under = (dir: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([p, d]) => [`${dir}/${p}`, d]));

const THEME = JSON.stringify({
  name: { en: "Acme", zh: "Acme" },
  schemes: { dark: { color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300" } } },
});
/** A declarative theme plugin without package.json (identified by its git source). */
const themeFiles = (name: string, version: string): Record<string, string> => ({
  ".capybara-plugin/plugin.json": JSON.stringify({
    schemaVersion: 1,
    name,
    version,
    publisher: "Acme",
    description: `Theme ${name}`,
  }),
  "themes/acme.json": THEME,
});
/** An extension plugin with its build output committed. */
async function extFiles(name: string, version: string): Promise<Record<string, string>> {
  const files = await unpackPackageTgz(
    await pluginTgz({
      manifest: { name, version },
      packageName: `@acme/plugin-${name}`,
      extension: {},
    }),
    { maxBytes: 10 * 1024 * 1024 },
  );
  return Object.fromEntries(files.map((f) => [f.path, f.data.toString("utf8")]));
}

/** The distribution's marketplace listing theme-x at `version`. */
const marketplaceJson = (version = "1.0.0") =>
  JSON.stringify({
    schemaVersion: 1,
    name: "Acme distribution",
    owner: { name: "Acme Corp" },
    plugins: [
      {
        name: "theme-x",
        version,
        summary: { en: "theme" },
        source: { path: "./plugins/theme-x" },
      },
    ],
  });

/** Repo `dist` at `theme-x@<themeVersion>` and `ext-x@1.0.0`; returns the commit and the trees. */
async function distCommit(themeVersion = "1.0.0") {
  const theme = themeFiles("theme-x", themeVersion);
  const ext = await extFiles("ext-x", "1.0.0");
  const commit = await srv.commit("dist", {
    ".capybara-plugin/marketplace.json": marketplaceJson(themeVersion),
    "README.md": "# dist\n",
    ...under("plugins/theme-x", theme),
    ...under("plugins/ext-x", ext),
  });
  return { commit, theme, ext };
}

const gitEntry = async (
  name: string,
  marketplace: string,
  commit: string,
  files: Record<string, string>,
  over: Partial<BootstrapGitEntry> = {},
): Promise<BootstrapGitEntry> => ({
  name,
  source: "git",
  marketplace,
  commit,
  path: `./plugins/${name}`,
  version: "1.0.0",
  integrity: sri(await packOf(files)),
  ...over,
});

/** The merged manifest of an empty built-in one and these git entries. */
const manifestOf = (
  plugins: BootstrapGitEntry[],
  marketplaces: BootstrapExtraManifest["marketplaces"] = [
    { name: "dist", url: srv.url("dist") },
    { name: "priv", url: priv.url("private"), username: USER },
  ],
): MergedBootstrapManifest =>
  mergeBootstrapManifests(
    { schemaVersion: 1, plugins: [] },
    {
      schemaVersion: 1,
      marketplaces,
      plugins,
    },
  );

/** As a kernel start does: the managed marketplace rows, then the bootstrap step. */
async function run(manifest: MergedBootstrapManifest, dir?: string, sync = true) {
  if (sync) {
    await k.app.get(MarketplacesService).syncExtraFromConfig(manifest.extra?.marketplaces ?? []);
  }
  return k.app.get(BootstrapService).run({
    manifest,
    imports: k.app.get(PluginImport),
    ...(dir !== undefined && { dir }),
  });
}

const versions = () =>
  db
    .selectFrom("catalog_item_versions as v")
    .innerJoin("catalog_items as i", "i.id", "v.item_id")
    .select([
      "i.name",
      "i.marketplace_id",
      "v.version",
      "v.source",
      "v.source_ref",
      "v.integrity",
      "v.source_detail",
    ])
    .orderBy("i.name")
    .orderBy("v.version")
    .execute();

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  priv = await startFakeGitServer({
    requireBasic: { username: USER, password: TOKEN },
    recordAuthorization: false,
  });
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-bootstrap-git-"));
  offlineDir = await mkdtemp(join(tmpdir(), "kernel-bootstrap-git-offline-"));
  config = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: pluginsDir },
      marketplaces: { allowInsecureLoopback: true, tokens: { priv: TOKEN } },
      extensions: [OBJECT_STORE],
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
  k = await startKernel(config, { env: {} });
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    superAdmin: true,
  });
  admin = await session(k, "root");
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await srv?.stop();
  await priv?.stop();
  for (const d of [pluginsDir, offlineDir]) if (d) await rm(d, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

beforeEach(async () => {
  // Every case installs other plugins (ext-x only in the first), so catalog rows are enough
  await truncateTables(
    db,
    "capybara.bootstrap_runs, capybara.plugin_import_staging, capybara.platform_themes, capybara.catalog_files, capybara.catalog_item_versions, capybara.catalog_items",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
  srv.requests.length = 0;
  priv.requests.length = 0;
});

describe("git entries of the extra bootstrap manifest", () => {
  it("a git entry is installed from the fake git server at its commit", async () => {
    const { commit, theme, ext } = await distCommit();
    // the branch moves on: the entry still reads its pinned commit
    await srv.commit("dist", { "README.md": "# moved\n" });
    const manifest = manifestOf([
      await gitEntry("theme-x", "dist", commit, theme),
      await gitEntry("ext-x", "dist", commit, ext),
    ]);
    const r = await run(manifest);
    expect(r.results).toEqual([
      { name: "theme-x", action: "imported", version: "1.0.0" },
      { name: "ext-x", action: "installed", version: "1.0.0" },
    ]);
    const themes = await db.selectFrom("platform_themes").select("plugin_name").execute();
    expect(themes).toEqual([{ plugin_name: "theme-x" }]);
    expect(
      await db
        .selectFrom("extension_installs")
        .select(["name", "version", "source", "desired_state"])
        .execute(),
    ).toEqual([{ name: "ext-x", version: "1.0.0", source: "bootstrap", desired_state: "enabled" }]);
    // pre-approved by the bootstrap, like a built-in entry
    expect(
      await db
        .selectFrom("extension_permission_snapshots")
        .select(["plugin", "source"])
        .where("plugin", "=", "ext-x")
        .execute(),
    ).toEqual([{ plugin: "ext-x", source: "bootstrap" }]);
    // the extension package is the verified pack, kept in PG
    const pkg = await db
      .selectFrom("extension_packages")
      .select(["blob_store", "sha256"])
      .where("name", "=", "ext-x")
      .executeTakeFirstOrThrow();
    expect(pkg.blob_store).toBe("pg");
    expect(pkg.sha256).toBe(
      createHash("sha256")
        .update(await packOf(ext))
        .digest("hex"),
    );
    // no credentials to a public marketplace
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === undefined)).toBe(true);
  });

  it("the catalog version records the managed marketplace source, and importFromMarketplace of the same entry is the same source", async () => {
    const { commit, theme } = await distCommit();
    const entry = await gitEntry("theme-x", "dist", commit, theme);
    const manifest = manifestOf([entry]);
    await run(manifest);
    const u = new URL(srv.url("dist"));
    expect(await versions()).toEqual([
      {
        name: "theme-x",
        marketplace_id: "config:dist",
        version: "1.0.0",
        source: "bootstrap",
        source_ref: `config:dist:${u.origin}${u.pathname}@${commit}:plugins/theme-x`,
        integrity: entry.integrity,
        source_detail: expect.objectContaining({
          host: u.host,
          repo: u.pathname.slice(1),
          path: "plugins/theme-x",
          commit,
          followsBranch: true,
          tree: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      },
    ]);
    // a later version comes from the managed marketplace
    await distCommit("1.1.0");
    const refresh = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces/config:dist/refresh",
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    const imp = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces/config:dist/entries/theme-x/import",
      payload: {},
    });
    expect(imp.statusCode, imp.body).toBe(200);
    const ok = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${imp.json().stagingId}/confirm`,
      payload: { reviewHash: imp.json().review.reviewHash },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    // the same item gets the version (another source would be catalog.name_conflict)
    expect(ok.json()).toMatchObject({ created: false, item: { marketplaceId: "config:dist" } });
    expect((await versions()).map((v) => [v.version, v.source])).toEqual([
      ["1.0.0", "bootstrap"],
      ["1.1.0", "git"],
    ]);
  });

  it("a private repo needs the token; the token is absent from the error when wrong", async () => {
    const files = themeFiles("priv-x", "1.0.0");
    const commit = await priv.commit("private", under("plugins/priv-x", files));
    const manifest = manifestOf([await gitEntry("priv-x", "priv", commit, files)]);
    // wrong token: bootstrap.git_read_failed, without the token
    const wrong = { ...config, marketplaces: { ...config.marketplaces, tokens: { priv: WRONG } } };
    const err = await resolveBootstrapPackages(manifest, { config: wrong }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "bootstrap.git_read_failed" });
    expect(String((err as Error).message)).toContain("priv-x");
    expect(JSON.stringify(err)).not.toContain(WRONG);
    expect(String((err as Error).message)).not.toContain(WRONG);
    // the configured token and username are sent, and only to the private origin
    priv.requests.length = 0;
    const r = await run(manifest);
    expect(r.results).toEqual([{ name: "priv-x", action: "imported", version: "1.0.0" }]);
    expect(priv.requests.length).toBeGreaterThan(0);
    expect(priv.requests.every((q) => q.authorized)).toBe(true);
    expect(srv.requests).toEqual([]);
    expect(await versions()).toEqual([
      expect.objectContaining({ name: "priv-x", marketplace_id: "config:priv" }),
    ]);
  });

  it("items capybara bootstrap imported before any start get the managed marketplace at the next sync", async () => {
    const { commit, theme } = await distCommit();
    const privFiles = themeFiles("priv-x", "1.0.0");
    const privCommit = await priv.commit("private", under("plugins/priv-x", privFiles));
    const manifest = manifestOf([
      await gitEntry("theme-x", "dist", commit, theme),
      await gitEntry("priv-x", "priv", privCommit, privFiles),
    ]);
    // as `capybara bootstrap` in compose init: no marketplace rows yet
    await run(manifest, undefined, false);
    const itemIds = async () =>
      Object.fromEntries(
        (await db.selectFrom("catalog_items").select(["name", "marketplace_id"]).execute()).map(
          (r) => [r.name, r.marketplace_id],
        ),
      );
    expect(await itemIds()).toEqual({ "theme-x": null, "priv-x": null });
    const svc = k.app.get(MarketplacesService);
    const dist = manifest.extra?.marketplaces.filter((m) => m.name === "dist") ?? [];
    // the kernel start: only the item whose source_ref names config:dist is backfilled
    await svc.syncExtraFromConfig(dist);
    expect(await itemIds()).toEqual({ "theme-x": "config:dist", "priv-x": null });
    await svc.syncExtraFromConfig(dist);
    expect(await itemIds()).toEqual({ "theme-x": "config:dist", "priv-x": null });
    // an item that already names another marketplace is left alone
    await db
      .updateTable("catalog_items")
      .set({ marketplace_id: "official" })
      .where("name", "=", "priv-x")
      .execute();
    await svc.syncExtraFromConfig(manifest.extra?.marketplaces ?? []);
    expect(await itemIds()).toEqual({ "theme-x": "config:dist", "priv-x": "official" });
    // the managed marketplace lists a newer version: the catalog says so
    await distCommit("1.1.0");
    const refresh = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces/config:dist/refresh",
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    const items = await admin({ method: "GET", url: "/api/v1/admin/catalog/items" });
    expect(items.statusCode, items.body).toBe(200);
    expect(
      (items.json().items as { name: string }[]).find((i) => i.name === "theme-x"),
    ).toMatchObject({
      marketplaceId: "config:dist",
      latestMarketplaceVersion: "1.1.0",
      newerInMarketplace: true,
    });
  });

  it("a tree that packs to another sha512 fails bootstrap.integrity_mismatch", async () => {
    const { theme } = await distCommit();
    const pinned = await gitEntry("theme-x", "dist", "0".repeat(40), theme);
    // the plugin changed under the same entry: a new commit, the old integrity
    const changed = await srv.commit("dist", {
      ".capybara-plugin/marketplace.json": marketplaceJson(),
      ...under("plugins/theme-x", { ...theme, "README.md": "# changed\n" }),
    });
    const manifest = manifestOf([{ ...pinned, commit: changed }]);
    // an optional entry: its failure only, and nothing of it is imported
    await expect(run(manifest)).rejects.toMatchObject({
      failures: [{ name: "theme-x", code: "bootstrap.integrity_mismatch" }],
    });
    expect(await versions()).toEqual([]);
    expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toEqual([]);
  });

  it("a tgz in the offline dir with the pinned sha512 is used without network", async () => {
    // a repo on a server that is gone by the time the bootstrap runs
    const gone = await startFakeGitServer();
    const files = themeFiles("theme-off", "1.0.0");
    const commit = await gone.commit("off", under("plugins/theme-off", files));
    const url = gone.url("off");
    await gone.stop();
    const entry = await gitEntry("theme-off", "off", commit, files);
    await writeFile(join(offlineDir, "any-name.tgz"), await packOf(files));
    const manifest = manifestOf([entry], [{ name: "off", url }]);
    const r = await run(manifest, offlineDir);
    expect(r.results).toEqual([{ name: "theme-off", action: "imported", version: "1.0.0" }]);
    // recorded as the managed marketplace's source all the same (no tree oid offline)
    const u = new URL(url);
    expect(await versions()).toEqual([
      expect.objectContaining({
        name: "theme-off",
        marketplace_id: "config:off",
        integrity: entry.integrity,
        source_detail: expect.objectContaining({
          host: u.host,
          path: "plugins/theme-off",
          commit,
        }),
      }),
    ]);
  });
});
