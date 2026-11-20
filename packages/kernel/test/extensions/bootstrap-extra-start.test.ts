import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapExtraManifest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { bootstrapManifestSha256 } from "../../src/extensions/bootstrap.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { bootstrapFixture, packFake, pluginTgz } from "../helpers/plugin-packages.js";
import { buildKernel, runConfig, type TestKernel } from "../helpers/runs.js";

/**
 * Kernel starts with and without the extra bootstrap manifest (spec
 * 2026-11-20-bootstrap-extra-manifest §5, final review F1): a start without it while
 * config-managed marketplaces exist is a configuration mismatch (nothing demoted, no bootstrap
 * step, an error naming the setting); a start whose extra manifest dropped an entry or a
 * marketplace clears and demotes them like a built-in entry left the built-in manifest.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let extensionsDir: string;
let extraDir: string;
let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
/** The distribution: marketplace `dist`, the builtin theme plugin `brand`, required `fake-bootstrap-a`. */
let extraManifest: string;
/** The same distribution removed: empty marketplaces and plugins lists. */
let emptyManifest: string;

const OBJECT_STORE_CONFIG = {
  extensionConfig: { "fake-bootstrap-b": { bucket: "bootstrap", secretKey: "s3cret" } },
};

const kernels: TestKernel[] = [];
async function stopAll(): Promise<void> {
  while (kernels.length > 0) await kernels.pop()?.close();
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

/** Starts a kernel with `extra` as its extra manifest (undefined: none configured). */
async function boot(
  extra: string | undefined,
  logger: KernelLogger = createLogger("error"),
): Promise<TestKernel> {
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: extensionsDir },
      log: { level: "error" },
      ...OBJECT_STORE_CONFIG,
    },
  );
  const k = await buildKernel(config, {
    env: {},
    logger,
    bootstrap: { dir: fx.dir, ...(extra !== undefined && { extraManifest: extra }) },
    bootstrapManifest: fx.manifest,
  });
  kernels.push(k);
  await k.start();
  return k;
}

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

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  extensionsDir = await mkdtemp(join(tmpdir(), "kernel-extra-start-ext-"));
  extraDir = await mkdtemp(join(tmpdir(), "kernel-extra-start-extra-"));
  // The built-in manifest: the object store (themes are kept there)
  fx = await bootstrapFixture([{ bytes: await packFake("fake-bootstrap-b") }]);
  // The extra manifest's packages, found in the offline directory by their sha512
  const brand = await pluginTgz({
    manifest: { name: "brand", version: "1.0.0" },
    files: {
      "themes/neon.json": JSON.stringify({
        name: { en: "neon", zh: "neon" },
        schemes: { dark: { radius: { sm: 2 } } },
      }),
    },
  });
  const ext = await packFake("fake-bootstrap-a");
  await writeFile(join(fx.dir, "brand-1.0.0.tgz"), brand);
  await writeFile(join(fx.dir, "fake-bootstrap-a.tgz"), ext);
  const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
  const extra: BootstrapExtraManifest = {
    schemaVersion: 1,
    marketplaces: [{ name: "dist", url: "https://git.example.com/acme/dist.git" }],
    plugins: [
      {
        name: "brand",
        source: "npm",
        npm: "@test/plugin-brand",
        version: "1.0.0",
        integrity: sri(brand),
        builtin: true,
      },
      {
        name: "fake-bootstrap-a",
        source: "npm",
        npm: "@test/plugin-fake-bootstrap-a",
        version: "0.1.0",
        integrity: sri(ext),
        required: true,
      },
    ],
  };
  extraManifest = join(extraDir, "bootstrap.extra.json");
  await writeFile(extraManifest, JSON.stringify(extra));
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
    "capybara.bootstrap_runs, capybara.catalog_files, capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.extension_name_owners, capybara.extension_org_configs, capybara.extension_catalog_sources, capybara.platform_theme_versions, capybara.platform_themes, capybara.catalog_item_versions, capybara.catalog_items, capybara.plugin_import_staging, capybara.audit_events",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
});

/** A start with the distribution's extra manifest: what every case starts from. */
async function distributed(): Promise<void> {
  await boot(extraManifest);
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
    const k = await boot(undefined, logger);
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
    await boot(undefined, logger);
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
    await boot(emptyManifest, logger);
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
  });
});
