import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapExtraManifest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import { PlatformPluginUpdater } from "../../src/catalog/plugin-upgrade.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { BootstrapFailedError, BootstrapService } from "../../src/extensions/bootstrap.js";
import {
  BootstrapExtraMismatchError,
  loadBootstrapManifest,
} from "../../src/extensions/bootstrap-extra.js";
import { bootstrapManifestSha256 } from "../../src/extensions/bootstrap-manifest.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { bootstrapFixture, packFake, pluginTgz } from "../helpers/plugin-packages.js";
import {
  type BuiltKernel,
  buildKernel,
  PW,
  runConfig,
  session,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The extra bootstrap manifest's `defaultTheme` (bootstrap extra manifest spec §7): every start
 * applies it while `uiTheme` is still the migration seed (`{ id: null }`, never saved by anyone),
 * whether or not the bootstrap step ran in that start; a super admin's choice is never reset.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let extensionsDir: string;
let extraDir: string;
let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
let extraManifest: string;
/**
 * A distribution with a managed marketplace (`dist`), the builtin `brand` and the required
 * `fake-bootstrap-a`; and the same distribution removed (empty lists).
 */
let distManifest: string;
let emptyManifest: string;
/** The distribution's entries without its marketplace (npm only, nothing managed). */
let npmOnlyManifest: string;

/** A declarative builtin plugin with two themes (no assets). */
const brandPkg = () =>
  pluginTgz({
    manifest: { name: "brand", version: "1.0.0" },
    files: Object.fromEntries(
      ["neon", "paper"].map((t) => [
        `themes/${t}.json`,
        JSON.stringify({
          name: { en: `${t} en`, zh: `${t} zh` },
          schemes: { dark: { radius: { sm: 2 } }, light: { radius: { md: 4 } } },
        }),
      ]),
    ),
  });

const OBJECT_STORE_CONFIG = {
  extensionConfig: { "fake-bootstrap-b": { bucket: "bootstrap", secretKey: "s3cret" } },
};

const kernels: TestKernel[] = [];
async function stopAll(): Promise<void> {
  while (kernels.length > 0) await kernels.pop()?.close();
}

async function boot(
  overrides: Record<string, unknown> = OBJECT_STORE_CONFIG,
  logger: KernelLogger = createLogger("error"),
  /** The extra manifest; null: none configured. */
  extra: string | null = extraManifest,
): Promise<TestKernel> {
  const k = await build(overrides, logger, extra);
  await k.start();
  return k;
}

/** A kernel built like {@link boot}'s, not started. */
async function build(
  overrides: Record<string, unknown>,
  logger: KernelLogger,
  extra: string | null,
): Promise<BuiltKernel> {
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: extensionsDir },
      log: { level: "error" },
      ...overrides,
    },
  );
  const k = await buildKernel(config, {
    env: {},
    logger,
    bootstrap: { dir: fx.dir, ...(extra !== null && { extraManifest: extra }) },
    bootstrapManifest: fx.manifest,
  });
  kernels.push(k);
  return k;
}

/** A logger that records warn and error lines and drops the rest. */
function recordingLogger(): {
  logger: KernelLogger;
  lines: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const base = createLogger("error");
  const logger = new Proxy(base, {
    get(t, k, receiver) {
      if (k === "warn" || k === "error") {
        return (msg: string, fields?: Record<string, unknown>) => {
          lines.push({ level: k, msg, ...(fields !== undefined && { fields }) });
        };
      }
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(k === "child" ? receiver : t) : v;
    },
  });
  return { logger, lines };
}

const themeId = async (name: string) =>
  (
    await db
      .selectFrom("platform_themes")
      .select("id")
      .where("plugin_name", "=", "brand")
      .where("name", "=", name)
      .executeTakeFirstOrThrow()
  ).id;
const uiThemeRow = () =>
  db
    .selectFrom("deployment_settings")
    .select(["value", "updated_by"])
    .where("key", "=", "uiTheme")
    .executeTakeFirstOrThrow();
const bootstrapWrites = async () =>
  (
    await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("action", "=", "deployment.settings.updated")
      .orderBy("id")
      .execute()
  ).filter((r) => (r.detail as { source?: string }).source === "bootstrap");
const platformTheme = async (k: TestKernel) =>
  (await k.http.inject({ method: "GET", url: "/api/v1/platform/theme" })).json() as {
    id: string;
  } | null;

async function adminSession(k: TestKernel) {
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    superAdmin: true,
  });
  return session(k, "root");
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  extensionsDir = await mkdtemp(join(tmpdir(), "kernel-default-theme-ext-"));
  extraDir = await mkdtemp(join(tmpdir(), "kernel-default-theme-extra-"));
  // The built-in manifest: the object store (themes are kept there), a bootstrap plugin itself
  fx = await bootstrapFixture([{ bytes: await packFake("fake-bootstrap-b") }]);
  // The extra manifest's builtin theme plugin, found in the offline directory by its sha512
  const brand = await brandPkg();
  await writeFile(join(fx.dir, "brand-1.0.0.tgz"), brand);
  const extra: BootstrapExtraManifest = {
    schemaVersion: 1,
    marketplaces: [],
    plugins: [
      {
        name: "brand",
        source: "npm",
        npm: "@test/plugin-brand",
        version: "1.0.0",
        integrity: `sha512-${createHash("sha512").update(brand).digest("base64")}`,
        builtin: true,
      },
    ],
    defaultTheme: { plugin: "brand", theme: "neon" },
  };
  extraManifest = join(extraDir, "bootstrap.extra.json");
  await writeFile(extraManifest, JSON.stringify(extra));
  const ext = await packFake("fake-bootstrap-a");
  await writeFile(join(fx.dir, "fake-bootstrap-a.tgz"), ext);
  const dist: BootstrapExtraManifest = {
    schemaVersion: 1,
    marketplaces: [{ name: "dist", url: "https://git.example.com/acme/dist.git" }],
    plugins: [
      { ...(extra.plugins[0] as BootstrapExtraManifest["plugins"][number]) },
      {
        name: "fake-bootstrap-a",
        source: "npm",
        npm: "@test/plugin-fake-bootstrap-a",
        version: "0.1.0",
        integrity: `sha512-${createHash("sha512").update(ext).digest("base64")}`,
        required: true,
      },
    ],
  };
  distManifest = join(extraDir, "bootstrap.dist.json");
  await writeFile(distManifest, JSON.stringify(dist));
  npmOnlyManifest = join(extraDir, "bootstrap.npm-only.json");
  await writeFile(npmOnlyManifest, JSON.stringify({ ...dist, marketplaces: [] }));
  emptyManifest = join(extraDir, "bootstrap.empty.json");
  await writeFile(
    emptyManifest,
    JSON.stringify({ schemaVersion: 1, marketplaces: [], plugins: [] }),
  );
});

afterAll(async () => {
  await stopAll();
  await fx?.cleanup();
  await destroyDb?.();
  await rm(extensionsDir, { recursive: true, force: true });
  await rm(extraDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await stopAll();
  await truncateTables(
    db,
    "capybara.bootstrap_runs, capybara.bootstrap_run_started, capybara.catalog_files, capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.extension_name_owners, capybara.extension_org_configs, capybara.extension_catalog_sources, capybara.platform_theme_versions, capybara.platform_themes, capybara.catalog_item_versions, capybara.catalog_items, capybara.plugin_import_staging, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
  // The migration seed (truncating accounts cascades to the settings): the built-in theme, saved
  // by nobody
  await db
    .insertInto("deployment_settings")
    .values({ key: "uiTheme", value: JSON.stringify({ id: null }) })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({ value: JSON.stringify({ id: null }), updated_by: null }),
    )
    .execute();
});

describe("the extra manifest's default theme", () => {
  it("a fresh deployment with defaultTheme serves it from /api/v1/platform/theme", async () => {
    const k = await boot();
    const neon = await themeId("neon");
    expect(await platformTheme(k)).toMatchObject({ id: neon });
    expect(await uiThemeRow()).toEqual({ value: { id: neon }, updated_by: null });
    expect(await bootstrapWrites()).toEqual([
      {
        actor_account_id: null,
        detail: {
          source: "bootstrap",
          uiTheme: { id: neon },
          defaultTheme: { plugin: "brand", theme: "neon" },
        },
      },
    ]);
  });

  it("a restart does not write again", async () => {
    await boot();
    await stopAll();
    const k = await boot();
    expect(await platformTheme(k)).toMatchObject({ id: await themeId("neon") });
    expect(await bootstrapWrites()).toHaveLength(1);
  });

  it("a super admin's explicit null is kept", async () => {
    const k = await boot();
    const admin = await adminSession(k);
    const r = await admin({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { uiTheme: { id: null } },
    });
    expect(r.statusCode, r.body).toBe(200);
    await stopAll();
    const again = await boot();
    expect(await platformTheme(again)).toBeNull();
    expect((await uiThemeRow()).value).toEqual({ id: null });
    expect(await bootstrapWrites()).toHaveLength(1);
  });

  it("a super admin's other theme is kept", async () => {
    const k = await boot();
    const paper = await themeId("paper");
    const admin = await adminSession(k);
    const r = await admin({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { uiTheme: { id: paper } },
    });
    expect(r.statusCode, r.body).toBe(200);
    await stopAll();
    const again = await boot();
    expect(await platformTheme(again)).toMatchObject({ id: paper });
    expect(await bootstrapWrites()).toHaveLength(1);
  });

  it("two concurrent applies on the seed: one applied, one kept, one write", async () => {
    const k = await boot();
    const paper = await themeId("paper");
    // Back to the seed, with no bootstrap write recorded
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ id: null }), updated_by: null })
      .where("key", "=", "uiTheme")
      .execute();
    await db
      .deleteFrom("audit_events")
      .where("action", "=", "deployment.settings.updated")
      .execute();
    const settings = k.app.get(SettingsService);
    const outcomes = await Promise.all([
      settings.applyBootstrapUiTheme(paper),
      settings.applyBootstrapUiTheme(paper),
    ]);
    expect(outcomes.sort()).toEqual(["applied", "kept"]);
    expect(await uiThemeRow()).toEqual({ value: { id: paper }, updated_by: null });
    expect(await bootstrapWrites()).toHaveLength(1);
  });

  it("theme row missing on the first start: warning, applied on the next start", async () => {
    // No object store config: the store does not run, so the theme plugin is not imported
    const { logger, lines } = recordingLogger();
    const first = await boot({}, logger);
    expect(first.port).toBeGreaterThan(0);
    expect(await platformTheme(first)).toBeNull();
    expect(await uiThemeRow()).toEqual({ value: { id: null }, updated_by: null });
    expect(
      lines.find((l) => l.level === "warn" && l.msg.includes("default theme"))?.fields,
    ).toMatchObject({ plugin: "brand", theme: "neon" });
    await stopAll();
    const k = await boot();
    expect(await platformTheme(k)).toMatchObject({ id: await themeId("neon") });
    expect(await bootstrapWrites()).toHaveLength(1);
  });
});

/*
 * Kernel starts with and without the extra manifest (spec 2026-11-20-bootstrap-extra-manifest,
 * "As built" R14): a start without it while config-managed marketplaces exist is a configuration
 * mismatch (nothing demoted, no bootstrap step, an error naming the setting); a start whose extra
 * manifest dropped the distribution demotes its marketplaces and clears required / builtin like
 * an entry that left the built-in manifest.
 */

const marketplaceRows = () =>
  db.selectFrom("marketplaces").select(["id", "managed"]).where("id", "<>", "official").execute();
const builtinItems = () =>
  db
    .selectFrom("catalog_items")
    .select(["name", "builtin"])
    .where("owner_org_id", "is", null)
    .where("deleted_at", "is", null)
    .orderBy("name")
    .execute();
const requiredInstall = async (name: string) =>
  (
    await db
      .selectFrom("extension_installs")
      .select("required")
      .where("name", "=", name)
      .executeTakeFirstOrThrow()
  ).required;
const runs = async () =>
  (await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).map(
    (r) => r.manifest_sha256,
  );

/** A start with the distribution's extra manifest: what every case starts from. */
async function distributed(): Promise<void> {
  await boot(OBJECT_STORE_CONFIG, createLogger("error"), distManifest);
  expect(await marketplaceRows()).toEqual([{ id: "config:dist", managed: "config" }]);
  expect(await builtinItems()).toEqual(expect.arrayContaining([{ name: "brand", builtin: true }]));
  expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
  await stopAll();
}

describe("a start without the extra manifest other services use", () => {
  it("demotes nothing, runs no bootstrap step, keeps the builtin flags and logs an error naming the setting", async () => {
    await distributed();
    const before = await runs();
    const { logger, lines } = recordingLogger();
    const k = await boot(OBJECT_STORE_CONFIG, logger, null);
    // The start itself goes on: the replica serves
    expect(k.port).toBeGreaterThan(0);
    expect(await marketplaceRows()).toEqual([{ id: "config:dist", managed: "config" }]);
    expect(await runs()).toEqual(before);
    expect(await runs()).not.toContain(bootstrapManifestSha256(fx.manifest));
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: true }]),
    );
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
    const err = lines.find(
      (l) => l.level === "error" && l.msg.includes("CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST"),
    );
    expect(err?.msg).toContain("every service");
    expect(err?.msg).toContain("empty");
    expect(err?.fields).toMatchObject({ marketplaces: ["dist"] });
  });

  it("a plain deployment (no extra manifest, no managed marketplace) logs nothing about it", async () => {
    const { logger, lines } = recordingLogger();
    await boot(OBJECT_STORE_CONFIG, logger, null);
    expect(await runs()).toEqual([bootstrapManifestSha256(fx.manifest)]);
    expect(lines.filter((l) => /extra bootstrap manifest|marketplaces left/.test(l.msg))).toEqual(
      [],
    );
  });
});

describe("an extra manifest that dropped the distribution", () => {
  it("an empty extra manifest demotes the marketplaces with a warning and clears required / builtin", async () => {
    await distributed();
    const { logger, lines } = recordingLogger();
    await boot(OBJECT_STORE_CONFIG, logger, emptyManifest);
    expect(await marketplaceRows()).toEqual([{ id: "config:dist", managed: null }]);
    // Like an entry that left the built-in manifest (`required_cleared`, builtin cleared)
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: false }]),
    );
    expect(await requiredInstall("fake-bootstrap-a")).toBe(false);
    const done = await db
      .selectFrom("bootstrap_runs")
      .select("results")
      .orderBy("completed_at", "desc")
      .executeTakeFirstOrThrow();
    expect(done.results).toEqual(
      expect.arrayContaining([
        { name: "fake-bootstrap-a", action: "required_cleared", version: "0.1.0" },
      ]),
    );
    expect(
      lines.find((l) => l.level === "warn" && l.msg.includes("left the extra bootstrap manifest"))
        ?.fields,
    ).toMatchObject({ marketplaces: ["dist"] });
    // The removal run flagged no extra entry: a later start without any extra manifest runs
    await stopAll();
    await boot(OBJECT_STORE_CONFIG, createLogger("error"), null);
    expect(await runs()).toContain(bootstrapManifestSha256(fx.manifest));
  });
});

describe("a replica without the extra manifest that raced one with it (ruling R16)", () => {
  it("read no managed marketplace before the other's sync committed: no demotion, no run, flags kept", async () => {
    await distributed();
    const before = await runs();
    const { logger, lines } = recordingLogger();
    const k = await build(OBJECT_STORE_CONFIG, logger, null);
    const svc = k.app.get(BootstrapService);
    // Its check before the sync ran before the other replica's sync committed: it saw no row
    vi.spyOn(svc, "extraManifestTraces").mockResolvedValueOnce({ marketplaces: [], plugins: [] });
    await k.start();
    expect(k.port).toBeGreaterThan(0);
    expect(await marketplaceRows()).toEqual([{ id: "config:dist", managed: "config" }]);
    expect(await runs()).toEqual(before);
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: true }]),
    );
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
    const err = lines.find(
      (l) => l.level === "error" && l.msg.includes("CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST"),
    );
    expect(err?.fields).toMatchObject({ marketplaces: ["dist"] });
    // The step itself refuses once it holds the lock (the CLI goes through it too)
    await expect(
      svc.run({
        manifest: fx.manifest,
        dir: fx.dir,
        imports: k.app.get(PluginImport),
        updater: k.app.get(PlatformPluginUpdater),
      }),
    ).rejects.toBeInstanceOf(BootstrapExtraMismatchError);
    expect(await runs()).toEqual(before);
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
  });
});

describe("the last bootstrap run tells an extra manifest apart (ruling R17)", () => {
  it("after an npm-only extra manifest (no marketplace row) a start without it is refused", async () => {
    // Like compose's init running `capybara bootstrap --extra-manifest`: no managed marketplace
    await boot();
    expect(await marketplaceRows()).toEqual([]);
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: true }]),
    );
    await stopAll();
    const before = await runs();
    const { logger, lines } = recordingLogger();
    const k = await boot(OBJECT_STORE_CONFIG, logger, null);
    expect(k.port).toBeGreaterThan(0);
    expect(await runs()).toEqual(before);
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: true }]),
    );
    const err = lines.find(
      (l) => l.level === "error" && l.msg.includes("CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST"),
    );
    expect(err?.msg).toContain("(brand)");
    expect(err?.fields).toMatchObject({ marketplaces: [], plugins: ["brand"] });
    // The step refuses under the lock too
    await expect(
      k.app.get(BootstrapService).run({
        manifest: fx.manifest,
        dir: fx.dir,
        imports: k.app.get(PluginImport),
        updater: k.app.get(PlatformPluginUpdater),
      }),
    ).rejects.toBeInstanceOf(BootstrapExtraMismatchError);
    expect(await runs()).toEqual(before);
  });

  it("an entry the built-in manifest dropped (not from an extra manifest) is not a mismatch", async () => {
    const k = await boot(OBJECT_STORE_CONFIG, createLogger("error"), null);
    expect(await requiredInstall("fake-bootstrap-b")).toBe(true);
    const dropped = { ...fx.manifest, plugins: [] };
    const r = await k.app.get(BootstrapService).run({
      manifest: dropped,
      dir: fx.dir,
      imports: k.app.get(PluginImport),
      updater: k.app.get(PlatformPluginUpdater),
    });
    expect(r.results).toEqual([
      expect.objectContaining({ name: "fake-bootstrap-b", action: "required_cleared" }),
    ]);
    expect(await runs()).toContain(bootstrapManifestSha256(dropped));
    expect(await requiredInstall("fake-bootstrap-b")).toBe(false);
    // The same extra part (none): the earlier manifest stays done, like a replica of the previous
    // release during a rolling upgrade (ruling R18)
    expect(await k.app.get(BootstrapService).isDone(fx.manifest)).toBe(true);
  });
});

describe("an extra manifest added back after its removal (ruling R18)", () => {
  it("runs again and restores required / builtin", async () => {
    await distributed();
    await boot(OBJECT_STORE_CONFIG, createLogger("error"), emptyManifest);
    expect(await requiredInstall("fake-bootstrap-a")).toBe(false);
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: false }]),
    );
    await stopAll();
    const k = await boot(OBJECT_STORE_CONFIG, createLogger("error"), distManifest);
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
    expect(await builtinItems()).toEqual(
      expect.arrayContaining([{ name: "brand", builtin: true }]),
    );
    const dist = await loadBootstrapManifest({ builtin: fx.manifest, extraManifest: distManifest });
    expect(await k.app.get(BootstrapService).isDone(dist)).toBe(true);
    // Its row was written again: one row per manifest, the latest completed run
    expect(await runs()).toHaveLength(2);
    expect(await db.selectFrom("bootstrap_run_started").selectAll().execute()).toEqual([]);
  });
});

describe("a run that has written but not completed (ruling R19)", () => {
  it("the first pass of an npm-only extra manifest already refuses a process without it", async () => {
    // A plain deployment whose built-in manifest is not done (an upgrade changed bootstrap.json)
    const k = await boot(OBJECT_STORE_CONFIG, createLogger("error"), null);
    await db.deleteFrom("bootstrap_runs").execute();
    const svc = k.app.get(BootstrapService);
    const imports = k.app.get(PluginImport);
    const updater = k.app.get(PlatformPluginUpdater);
    const npmOnly = await loadBootstrapManifest({
      builtin: fx.manifest,
      extraManifest: npmOnlyManifest,
    });
    // The first pass installs the required extra entry and defers the builtin one: not recorded
    await expect(
      svc.run({ manifest: npmOnly, dir: fx.dir, imports, updater, deferBuiltin: true }),
    ).rejects.toBeInstanceOf(BootstrapFailedError);
    expect(await runs()).toEqual([]);
    expect(await marketplaceRows()).toEqual([]);
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
    expect(await svc.extraManifestTraces()).toEqual({
      marketplaces: [],
      plugins: ["brand", "fake-bootstrap-a"],
    });
    // A process without the extra manifest whose built-in manifest is not done yet
    await expect(
      svc.run({ manifest: fx.manifest, dir: fx.dir, imports, updater }),
    ).rejects.toBeInstanceOf(BootstrapExtraMismatchError);
    expect(await runs()).toEqual([]);
    expect(await requiredInstall("fake-bootstrap-a")).toBe(true);
  });
});
