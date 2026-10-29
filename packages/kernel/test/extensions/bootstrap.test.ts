import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BootstrapManifest, bootstrapFileName } from "@capybara-hq/plugin-sdk";
import {
  type FakeNpmPackage,
  type FakeNpmRegistry,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  BootstrapFailedError,
  BootstrapService,
  bootstrapManifestSha256,
} from "../../src/extensions/bootstrap.js";
import { enabledExtensionsByOrg, isExtensionEnabled } from "../../src/extensions/enabled.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, lifePkg, packFake, pluginTgz } from "../helpers/plugin-packages.js";
import {
  buildKernel,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  type TestKernel,
} from "../helpers/runs.js";

const PERM_A = fileURLToPath(new URL("../fixtures/plugins/perm-a/index.ts", import.meta.url));

/**
 * The bootstrap step (package ecosystem spec §7, phase A2 Review Focus 2-4): what each manifest
 * entry turns into, re-runs, a core upgrade, tampered or missing packages, and the required plugins
 * every org gets without config rows. Kernels run with `extensionPermissions.autoApprove: false`, so
 * a loaded bootstrap plugin proves its permissions were pre-approved.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let extensionsDir: string;
const cleanups: (() => Promise<void>)[] = [];

const kernels: TestKernel[] = [];
async function boot(
  fx: { dir: string; manifest: BootstrapManifest } | undefined,
  overrides: Record<string, unknown> = {},
  logger: KernelLogger = createLogger("error"),
): Promise<TestKernel> {
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: extensionsDir },
      extensionPermissions: { autoApprove: false },
      log: { level: "error" },
      ...overrides,
    },
  );
  const k = await buildKernel(config, {
    env: {},
    logger,
    ...(fx !== undefined && { bootstrap: { dir: fx.dir }, bootstrapManifest: fx.manifest }),
  });
  kernels.push(k);
  await k.start();
  return k;
}
async function stopAll(): Promise<void> {
  while (kernels.length > 0) await kernels.pop()?.close();
}

async function fixture(...args: Parameters<typeof bootstrapFixture>) {
  const fx = await bootstrapFixture(...args);
  cleanups.push(fx.cleanup);
  return fx;
}

async function reset(): Promise<void> {
  await stopAll();
  await truncateTables(
    db,
    "capybara.bootstrap_runs, capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.extension_name_owners, capybara.extension_org_configs, capybara.extension_catalog_sources, capybara.catalog_item_versions, capybara.catalog_items, capybara.plugin_import_staging, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
}

const installs = () =>
  db
    .selectFrom("extension_installs")
    .select(["name", "version", "source", "desired_state", "required"])
    .orderBy("name")
    .execute();
const audits = (action: string) =>
  db
    .selectFrom("audit_events")
    .select(["target", "detail"])
    .where("action", "=", action)
    .orderBy("id")
    .execute();
const snapshot = (plugin: string) =>
  db
    .selectFrom("extension_permission_snapshots")
    .select(["version", "source"])
    .where("plugin", "=", plugin)
    .executeTakeFirst();

let admin: Req;
async function loginAdmin(k: TestKernel): Promise<void> {
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  extensionsDir = await mkdtemp(join(tmpdir(), "kernel-bootstrap-ext-"));
}, 240_000);
afterAll(async () => {
  await stopAll();
  for (const c of cleanups) await c();
  await destroyDb?.();
  await rm(extensionsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("a fresh deployment", () => {
  let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
  let k: TestKernel;
  beforeAll(async () => {
    await reset();
    fx = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }), required: true },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }), required: false },
    ]);
    // A development deployment that ran the builtin extensions: their names were claimed (by the
    // same npm package), with no install record. The bootstrap step installs them all the same.
    await db
      .insertInto("extension_name_owners")
      .values({ name: "alpha", package_name: "@test/plugin-alpha" })
      .execute();
    k = await boot(fx);
    await loginAdmin(k);
  }, 120_000);
  afterAll(stopAll);

  it("installs, pre-approves and enables every entry, recorded like a marketplace import", async () => {
    expect(await installs()).toEqual([
      {
        name: "alpha",
        version: "1.0.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: true,
      },
      {
        name: "beta",
        version: "1.0.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: false,
      },
    ]);
    // autoApprove is off: loading proves the bootstrap snapshot
    expect(k.app.get(ExtensionHost).current("alpha")?.manifest.version).toBe("1.0.0");
    expect(k.app.get(ExtensionHost).current("beta")?.manifest.version).toBe("1.0.0");
    expect(await snapshot("alpha")).toEqual({ version: "1.0.0", source: "bootstrap" });
    const approved = await audits("extension.permissions_approved");
    expect(approved.map((a) => a.target).sort()).toEqual(["alpha", "beta"]);
    for (const a of approved) expect(a.detail).toMatchObject({ source: "bootstrap" });
    // The packages are kept in PG (the object store may be a bootstrap plugin itself)
    const pkgs = await db
      .selectFrom("extension_packages")
      .select(["name", "blob_store", "source", "source_ref"])
      .orderBy("name")
      .execute();
    expect(pkgs).toEqual([
      { name: "alpha", blob_store: "pg", source: "bootstrap", source_ref: "bootstrap:alpha@1.0.0" },
      { name: "beta", blob_store: "pg", source: "bootstrap", source_ref: "bootstrap:beta@1.0.0" },
    ]);
    // Catalog records shaped like a marketplace import, with source bootstrap
    const versions = await db
      .selectFrom("catalog_item_versions as v")
      .innerJoin("catalog_items as i", "i.id", "v.item_id")
      .select(["i.name", "v.version", "v.source", "v.source_ref", "v.integrity"])
      .orderBy("i.name")
      .execute();
    expect(versions).toEqual(
      ["alpha", "beta"].map((name) => ({
        name,
        version: "1.0.0",
        source: "bootstrap",
        source_ref: `bootstrap:${name}@1.0.0`,
        integrity: fx.manifest.plugins.find((p) => p.name === name)?.integrity,
      })),
    );
    const sha = bootstrapManifestSha256(fx.manifest);
    expect(await k.app.get(BootstrapService).isDone(sha)).toBe(true);
    const completed = await audits("bootstrap.completed");
    expect(completed).toEqual([
      {
        target: sha,
        detail: {
          manifestSha256: sha,
          results: [
            { name: "alpha", action: "installed", version: "1.0.0" },
            { name: "beta", action: "installed", version: "1.0.0" },
          ],
        },
      },
    ]);
  });

  it("a second run of the same manifest does nothing", async () => {
    const writes = async () =>
      (
        await db
          .selectFrom("audit_events")
          .select("action")
          .where("action", "like", "%.%")
          .where("action", "not like", "auth.%")
          .execute()
      ).length;
    const before = await writes();
    const r = await k.app.get(BootstrapService).run({
      manifest: fx.manifest,
      dir: fx.dir,
      imports: k.app.get(PluginImport),
    });
    expect(r.results.map((x) => x.action)).toEqual(["installed", "installed"]);
    await stopAll();
    k = await boot(fx);
    admin = await session(k, "root");
    expect(await writes()).toBe(before);
    expect(await audits("bootstrap.completed")).toHaveLength(1);
    expect((await installs()).map((r) => r.version)).toEqual(["1.0.0", "1.0.0"]);
  });

  it("an org created after bootstrap has the required plugins enabled without config rows", async () => {
    const orgId = await createOrg(admin, "Later");
    expect(
      await db
        .selectFrom("extension_org_configs")
        .select("plugin")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([]);
    const enabled = await k.app.get(ExtensionHost).enabledPlugins(orgId);
    expect(enabled.has("alpha")).toBe(true);
    expect(enabled.has("beta")).toBe(false);
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(list.statusCode).toBe(200);
    const byName = new Map(
      (list.json().extensions as { plugin: string; enabled: boolean; required: boolean }[]).map(
        (p) => [p.plugin, p],
      ),
    );
    expect(byName.get("alpha")).toMatchObject({ enabled: true, required: true });
    expect(byName.get("beta")).toMatchObject({ enabled: false, required: false });
    // The shared helpers every direct reader uses
    expect(await isExtensionEnabled(db, orgId, "alpha")).toBe(true);
    expect(await isExtensionEnabled(db, orgId, "beta")).toBe(false);
    const pairs = await enabledExtensionsByOrg(db).execute();
    expect(pairs).toContainEqual({ org_id: orgId, plugin: "alpha" });
    expect(pairs).not.toContainEqual({ org_id: orgId, plugin: "beta" });
    // A required plugin's tools are available to the org's agents
    const tools = await k.app.get(ToolRegistry).forAgent(orgId, {
      tools: [{ kind: "plugin", plugin: "alpha", name: "wait" }],
    });
    expect(tools.tools.map((t) => t.key)).toEqual(["alpha__wait"]);
  });

  it("a required plugin cannot be disabled in an org or on the deployment, nor uninstalled (409 extension.required)", async () => {
    const orgId = await createOrg(admin, "Strict");
    const put = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/alpha`,
      payload: { enabled: false },
    });
    expect(put.statusCode, put.body).toBe(409);
    expect(put.json().error.code).toBe("extension.required");
    for (const [method, url] of [
      ["POST", "/api/v1/admin/extensions/alpha/disable"],
      ["DELETE", "/api/v1/admin/extensions/alpha"],
    ] as const) {
      const res = await admin({ method, url });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(409);
      expect(res.json().error.code).toBe("extension.required");
    }
    const view = await admin({ method: "GET", url: "/api/v1/admin/extensions/alpha" });
    expect(view.json()).toMatchObject({
      required: true,
      removable: false,
      installSource: "bootstrap",
    });
    expect((await installs()).find((r) => r.name === "alpha")?.desired_state).toBe("enabled");
    // An optional bootstrap plugin is managed like any other
    const off = await admin({ method: "POST", url: "/api/v1/admin/extensions/beta/disable" });
    expect(off.statusCode, off.body).toBe(200);
    expect(
      (await admin({ method: "POST", url: "/api/v1/admin/extensions/beta/enable" })).statusCode,
    ).toBe(200);
  });
});

describe("a core upgrade (Review Focus 3)", () => {
  it("raises a pinned version, keeps a hand-upgraded plugin, clears required from a removed entry", async () => {
    await reset();
    const v1 = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "gamma", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "delta", version: "1.0.0" }), required: false },
      { bytes: await lifePkg({ name: "epsilon", version: "1.0.0" }), required: false },
    ]);
    let k = await boot(v1);
    await loginAdmin(k);
    // The enterprise admin disables delta and uninstalls epsilon (both optional)
    for (const [method, url] of [
      ["POST", "/api/v1/admin/extensions/delta/disable"],
      ["POST", "/api/v1/admin/extensions/epsilon/disable"],
      ["DELETE", "/api/v1/admin/extensions/epsilon"],
    ] as const) {
      const res = await admin({ method, url });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    }
    // The enterprise admin upgrades beta by hand above what core pins
    const beta12 = await lifePkg({ name: "beta", version: "1.2.0" });
    const up = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/packages/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(beta12),
    });
    expect(up.statusCode, up.body).toBe(200);
    const inst = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/beta/install",
      payload: { sha256: up.json().sha256 },
    });
    expect(inst.statusCode, inst.body).toBe(200);
    await stopAll();

    // The new core: alpha raised (with a new permission, pre-approved), beta still 1.0.0, gamma
    // gone, delta raised, epsilon unchanged, zeta new
    const v2 = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.1.0", policy: true }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "delta", version: "1.1.0" }), required: false },
      { bytes: await lifePkg({ name: "epsilon", version: "1.0.0" }), required: false },
      { bytes: await lifePkg({ name: "zeta", version: "1.0.0" }), required: false },
    ]);
    k = await boot(v2);
    const r = (await audits("bootstrap.completed")).at(-1)?.detail as { results: unknown[] };
    expect(r.results).toEqual([
      { name: "alpha", action: "upgraded", version: "1.1.0" },
      { name: "beta", action: "kept", version: "1.2.0" },
      // upgraded, but still disabled as the admin left it
      { name: "delta", action: "upgraded", version: "1.1.0" },
      // not new to the manifest: the admin's uninstall stands (Ruling 5)
      { name: "epsilon", action: "kept", version: "1.0.0" },
      { name: "zeta", action: "installed", version: "1.0.0" },
      { name: "gamma", action: "required_cleared", version: "1.0.0" },
    ]);
    expect(await installs()).toEqual([
      {
        name: "alpha",
        version: "1.1.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: true,
      },
      { name: "beta", version: "1.2.0", source: "file", desired_state: "enabled", required: true },
      {
        name: "delta",
        version: "1.1.0",
        source: "bootstrap",
        desired_state: "disabled",
        required: false,
      },
      {
        name: "gamma",
        version: "1.0.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: false,
      },
      {
        name: "zeta",
        version: "1.0.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: false,
      },
    ]);
    expect(k.app.get(ExtensionHost).current("delta")).toBeUndefined();
    expect(k.app.get(ExtensionHost).current("epsilon")).toBeUndefined();
    expect(await snapshot("alpha")).toEqual({ version: "1.1.0", source: "bootstrap" });
    const approved = (await audits("extension.permissions_approved")).filter(
      (a) => a.target === "alpha",
    );
    expect(approved.at(-1)?.detail).toMatchObject({
      version: "1.1.0",
      source: "bootstrap",
      added: expect.arrayContaining([expect.stringContaining("tool.preExecute")]),
    });
    // autoApprove is off: the raised version loads with the added permission pre-approved
    expect(k.app.get(ExtensionHost).current("alpha")?.manifest.version).toBe("1.1.0");
    expect(k.app.get(ExtensionHost).current("beta")?.manifest.version).toBe("1.2.0");
    expect(k.app.get(ExtensionHost).current("gamma")?.manifest.version).toBe("1.0.0");
    // gamma is an ordinary install now: it can be disabled
    admin = await session(k, "root");
    const off = await admin({ method: "POST", url: "/api/v1/admin/extensions/gamma/disable" });
    expect(off.statusCode, off.body).toBe(200);
  });
});

describe("same version, different bytes", () => {
  it("keeps the installed package and warns naming the plugin", async () => {
    await reset();
    const v1 = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    await boot(v1);
    await stopAll();
    // A pin rebuilt from changed code without a version bump
    const v2 = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0", policy: true }) },
    ]);
    expect(v2.manifest.plugins[0]?.integrity).not.toBe(v1.manifest.plugins[0]?.integrity);
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const base = createLogger("error");
    const logger = new Proxy(base, {
      get(t, k) {
        if (k === "warn") {
          return (msg: string, fields?: Record<string, unknown>) => {
            warns.push({ msg, ...(fields !== undefined && { fields }) });
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const k = await boot(v2, {}, logger);
    const r = (await audits("bootstrap.completed")).at(-1)?.detail as { results: unknown[] };
    expect(r.results).toEqual([{ name: "alpha", action: "kept", version: "1.0.0" }]);
    expect(k.app.get(ExtensionHost).current("alpha")?.manifest.version).toBe("1.0.0");
    expect(
      warns.filter((w) => w.msg.includes("differs from the installed one at the same version")),
    ).toEqual([
      {
        msg: expect.stringContaining("bootstrap:"),
        fields: { plugin: "alpha", version: "1.0.0" },
      },
    ]);
  });
});

describe("tampered and missing packages (Review Focus 2)", () => {
  const tampered = async (): Promise<{ dir: string; manifest: BootstrapManifest }> => {
    const fx = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
    ]);
    const file = join(fx.dir, bootstrapFileName(fx.manifest.plugins[1] as never));
    const bytes = await readFile(file);
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] as number) ^ 1;
    await writeFile(file, bytes);
    return fx;
  };

  beforeEach(reset);

  it("one changed byte: not that entry's package (a workspace entry: missing), nothing installed, the kernel does not start", async () => {
    const fx = await tampered();
    await expect(boot(fx)).rejects.toMatchObject({
      code: "bootstrap.missing_file",
      message: expect.stringContaining("Bootstrap plugin beta 1.0.0"),
    });
    expect(kernels.at(-1)?.port).toBeUndefined();
    kernels.pop();
    expect(await installs()).toEqual([]);
    expect(await db.selectFrom("catalog_items").select("name").execute()).toEqual([]);
    expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toEqual([]);
  });

  it("a missing package: bootstrap.missing_file", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const other = await mkdtemp(join(tmpdir(), "kernel-bootstrap-empty-"));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    const k = await boot(undefined);
    await expect(
      k.app
        .get(BootstrapService)
        .run({ manifest: fx.manifest, dir: other, imports: k.app.get(PluginImport) }),
    ).rejects.toMatchObject({
      code: "bootstrap.missing_file",
      message: expect.stringContaining("alpha"),
    });
    expect(await installs()).toEqual([]);
  });

  it("a required entry that fails stops the start; a failed optional one is retried next start", async () => {
    // A package whose plugin is not the one the entry names
    const good = await lifePkg({ name: "alpha", version: "1.0.0" });
    const fx = await fixture([
      { bytes: good },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
    ]);
    const wrong = await lifePkg({ name: "other", version: "1.0.0" });
    const beta = fx.manifest.plugins[1] as BootstrapManifest["plugins"][number];
    await writeFile(join(fx.dir, bootstrapFileName(beta)), wrong);
    beta.integrity = `sha512-${createHash("sha512").update(wrong).digest("base64")}`;

    await expect(boot(fx)).rejects.toBeInstanceOf(BootstrapFailedError);
    kernels.pop();
    // alpha was done; the run is not recorded, so the next start tries again
    expect((await installs()).map((r) => r.name)).toEqual(["alpha"]);
    expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toEqual([]);

    beta.required = false;
    const k = await boot(fx);
    expect(k.port).toBeGreaterThan(0);
    expect(k.app.get(ExtensionHost).current("alpha")).toBeDefined();
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      false,
    );

    // Fixed in a later image: the next start completes it
    await stopAll();
    const fixed = await lifePkg({ name: "beta", version: "1.0.0" });
    await writeFile(join(fx.dir, bootstrapFileName(beta)), fixed);
    beta.integrity = `sha512-${createHash("sha512").update(fixed).digest("base64")}`;
    const k2 = await boot(fx);
    expect(await k2.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      true,
    );
    expect((await installs()).map((r) => [r.name, r.version])).toEqual([
      ["alpha", "1.0.0"],
      ["beta", "1.0.0"],
    ]);
  });
});

describe("obtaining the packages: offline directory, else npm (startup bootstrap spec)", () => {
  let reg: FakeNpmRegistry | undefined;
  const tarballs = () => (reg?.requests ?? []).filter((r) => r.includes("/-/"));
  const npmFixture = async () =>
    fixture(
      [
        { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) },
        { bytes: await lifePkg({ name: "beta", version: "1.0.0" }), required: false },
      ],
      { source: "npm" },
    );
  const serve = async (packages: FakeNpmPackage[]) => {
    reg = await startFakeNpmRegistry({ packages });
    return reg;
  };
  /** A registry URL nothing listens on. */
  const downRegistry = async () => {
    const r = await startFakeNpmRegistry({ packages: [] });
    await r.stop();
    return r.url;
  };

  beforeEach(reset);
  afterEach(async () => {
    await stopAll();
    await reg?.stop();
    reg = undefined;
  });

  it("an empty directory: downloads every entry from the registry, once each", async () => {
    const fx = await npmFixture();
    await serve(fx.packages);
    const k = await boot(fx, { packages: { npmRegistry: reg?.url } });
    expect((await installs()).map((r) => [r.name, r.version, r.source])).toEqual([
      ["alpha", "1.0.0", "bootstrap"],
      ["beta", "1.0.0", "bootstrap"],
    ]);
    expect(k.app.get(ExtensionHost).current("alpha")?.manifest.version).toBe("1.0.0");
    expect(tarballs()).toEqual([
      "/@test/plugin-alpha/-/plugin-alpha-1.0.0.tgz",
      "/@test/plugin-beta/-/plugin-beta-1.0.0.tgz",
    ]);
  });

  it("a file of any name with the pinned sha512 is used; the registry is not asked", async () => {
    const fx = await npmFixture();
    for (const [i, p] of fx.packages.entries()) {
      await writeFile(join(fx.dir, `download-${i}.tgz`), p.tgz);
    }
    await writeFile(join(fx.dir, "notes.txt"), "not a package");
    const k = await boot(fx, { packages: { npmRegistry: await downRegistry() } });
    expect((await installs()).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(k.port).toBeGreaterThan(0);
  });

  it("a file named like the entry with other bytes is ignored: the registry's matching bytes are installed", async () => {
    const fx = await npmFixture();
    await writeFile(
      join(fx.dir, bootstrapFileName(fx.manifest.plugins[0] as never)),
      await lifePkg({ name: "alpha", version: "1.0.0", policy: true }),
    );
    await serve(fx.packages);
    await boot(fx, { packages: { npmRegistry: reg?.url } });
    expect((await installs()).map((r) => r.name)).toEqual(["alpha", "beta"]);
    const sha = await db
      .selectFrom("extension_installs")
      .select("sha256")
      .where("name", "=", "alpha")
      .executeTakeFirstOrThrow();
    expect(sha.sha256).toBe(
      createHash("sha256")
        .update(fx.packages[0]?.tgz as Uint8Array)
        .digest("hex"),
    );
  });

  it("a download that differs from the pin: bootstrap.integrity_mismatch, nothing written", async () => {
    const fx = await npmFixture();
    const other = await lifePkg({ name: "beta", version: "1.0.0", policy: true });
    // The packument even claims the other bytes' integrity: only the pin counts
    await serve([
      fx.packages[0] as FakeNpmPackage,
      { ...(fx.packages[1] as FakeNpmPackage), tgz: other },
    ]);
    await expect(boot(fx, { packages: { npmRegistry: reg?.url } })).rejects.toMatchObject({
      code: "bootstrap.integrity_mismatch",
      message: expect.stringContaining("Bootstrap plugin beta 1.0.0"),
    });
    kernels.pop();
    expect(await installs()).toEqual([]);
    expect(await db.selectFrom("catalog_items").select("name").execute()).toEqual([]);
    expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toEqual([]);
  });

  it("the registry unreachable: bootstrap.download_failed naming the plugin, the registry and the directory", async () => {
    const fx = await npmFixture();
    const url = await downRegistry();
    const err = await boot(fx, { packages: { npmRegistry: url } }).then(
      () => undefined,
      (e: unknown) => e as { code: string; message: string },
    );
    kernels.pop();
    expect(err?.code).toBe("bootstrap.download_failed");
    expect(err?.message).toContain("Bootstrap plugin alpha 1.0.0");
    expect(err?.message).toContain(new URL(url).origin);
    expect(err?.message).toContain(fx.dir);
    expect(err?.message).toContain("npm pack @test/plugin-alpha@1.0.0");
    expect(await installs()).toEqual([]);
  });

  it("a workspace entry without a matching file: bootstrap.missing_file (never downloaded)", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const empty = await mkdtemp(join(tmpdir(), "kernel-bootstrap-empty-"));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    await serve(fx.packages);
    await expect(
      boot({ dir: empty, manifest: fx.manifest }, { packages: { npmRegistry: reg?.url } }),
    ).rejects.toMatchObject({ code: "bootstrap.missing_file" });
    kernels.pop();
    expect(reg?.requests).toEqual([]);
  });

  it("once done, a restart needs neither the directory nor the registry", async () => {
    const fx = await npmFixture();
    await serve(fx.packages);
    await boot(fx, { packages: { npmRegistry: reg?.url } });
    await stopAll();
    await reg?.stop();
    const before = reg?.requests.length;
    await rm(fx.dir, { recursive: true, force: true });
    const k = await boot(fx, { packages: { npmRegistry: reg?.url } });
    expect(k.port).toBeGreaterThan(0);
    // The service itself checks "done" before touching anything
    const r = await k.app.get(BootstrapService).run({
      manifest: fx.manifest,
      dir: fx.dir,
      imports: k.app.get(PluginImport),
    });
    expect(r.results.map((x) => x.action)).toEqual(["installed", "installed"]);
    expect(reg?.requests.length).toBe(before);
  });

  it("packages.npmToken reaches the registry", async () => {
    const fx = await npmFixture();
    await serve(fx.packages);
    await boot(fx, { packages: { npmRegistry: reg?.url, npmToken: "tok-bootstrap" } });
    expect(reg?.authorizations.length).toBeGreaterThan(0);
    expect(new Set(reg?.authorizations)).toEqual(new Set(["Bearer tok-bootstrap"]));
  });
});

describe("a declarative entry", () => {
  afterAll(stopAll);

  it("goes to the catalog only, once the object store (a bootstrap plugin itself) has loaded", async () => {
    await reset();
    const fx = await fixture([
      { bytes: await packFake("fake-bootstrap-b") },
      {
        bytes: await pluginTgz({
          manifest: { name: "delta", version: "1.0.0" },
          files: {
            "skills/hello/SKILL.md":
              "---\nname: hello\ndescription: Says hello.\n---\nSay hello.\n",
          },
        }),
        required: false,
      },
    ]);
    const k = await boot(fx, {
      extensionConfig: {
        "fake-bootstrap-b": { bucket: "bootstrap", secretKey: "s3cret" },
      },
    });
    expect(k.app.get(StorageService).available).toBe(true);
    expect((await installs()).map((r) => [r.name, r.source, r.required])).toEqual([
      ["fake-bootstrap-b", "bootstrap", true],
    ]);
    const delta = await db
      .selectFrom("catalog_item_versions as v")
      .innerJoin("catalog_items as i", "i.id", "v.item_id")
      .select(["v.source", "v.source_ref", "v.extension_sha256"])
      .where("i.name", "=", "delta")
      .executeTakeFirstOrThrow();
    expect(delta).toEqual({
      source: "bootstrap",
      source_ref: "bootstrap:delta@1.0.0",
      extension_sha256: null,
    });
    // The first pass (before the extensions loaded) installed the object store; the pass after
    // the startup reconcile imported delta and completed the run, recording both passes' actions
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      true,
    );
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [
        { name: "fake-bootstrap-b", action: "installed", version: "0.1.0" },
        { name: "delta", action: "imported", version: "1.0.0" },
      ],
    });
  });
});

describe("config-declared names and the lock", () => {
  beforeEach(reset);

  it("an entry also declared in the config extensions list is kept: config wins, no install record", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "perm-a", version: "1.0.0" }) }]);
    const k = await boot(fx, { extensions: [MODEL_FAKE, PERM_A] });
    expect(k.app.get(ExtensionHost).sourceOf("perm-a")).toBe("config");
    expect(await installs()).toEqual([]);
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [{ name: "perm-a", action: "kept", version: "1.0.0" }],
    });
  });

  it("a run longer than the lock's TTL keeps lock:bootstrap by renewal; another holder cannot take it", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const k = await boot(undefined);
    const probe = new Redis(rd.url);
    const bootstrap = k.app.get(BootstrapService);
    bootstrap.lockTtlMs = 300;
    try {
      const imports = {
        prepare: async (...a: Parameters<PluginImport["prepare"]>) => {
          // the run outlives the TTL several times over
          await new Promise((r) => setTimeout(r, 1_200));
          return k.app.get(PluginImport).prepare(...a);
        },
        confirm: (...a: Parameters<PluginImport["confirm"]>) =>
          k.app.get(PluginImport).confirm(...a),
      };
      const running = bootstrap.run({ manifest: fx.manifest, dir: fx.dir, imports });
      await new Promise((r) => setTimeout(r, 900));
      expect(await probe.exists("lock:bootstrap")).toBe(1);
      expect(await probe.set("lock:bootstrap", "other", "PX", 1_000, "NX")).toBeNull();
      const r = await running;
      expect(r.results).toEqual([{ name: "alpha", action: "installed", version: "1.0.0" }]);
      expect(await probe.exists("lock:bootstrap")).toBe(0);
    } finally {
      bootstrap.lockTtlMs = 120_000;
      probe.disconnect();
    }
  });

  it("a run that loses lock:bootstrap mid-run rejects naming the lock and records nothing as done", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const k = await boot(undefined);
    const probe = new Redis(rd.url);
    const bootstrap = k.app.get(BootstrapService);
    bootstrap.lockTtlMs = 300;
    try {
      const imports = {
        prepare: async (...a: Parameters<PluginImport["prepare"]>) => {
          // another holder takes the key while the run is busy: the next renewal fails
          await probe.set("lock:bootstrap", "another-replica", "PX", 5_000);
          await new Promise((r) => setTimeout(r, 600));
          return k.app.get(PluginImport).prepare(...a);
        },
        confirm: (...a: Parameters<PluginImport["confirm"]>) =>
          k.app.get(PluginImport).confirm(...a),
      };
      await expect(bootstrap.run({ manifest: fx.manifest, dir: fx.dir, imports })).rejects.toThrow(
        "lock lost: lock:bootstrap",
      );
      const runs = await db
        .selectFrom("bootstrap_runs")
        .select("manifest_sha256")
        .where("manifest_sha256", "=", bootstrapManifestSha256(fx.manifest))
        .execute();
      expect(runs).toEqual([]);
      // the other holder's key is left alone
      expect(await probe.get("lock:bootstrap")).toBe("another-replica");
    } finally {
      bootstrap.lockTtlMs = 120_000;
      await probe.del("lock:bootstrap");
      probe.disconnect();
    }
  });

  it("a crashed holder's lock:bootstrap expires within its TTL and the waiting run goes on", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const k = await boot(undefined);
    const crashed = new Redis(rd.url);
    try {
      // a holder that took the lock and died: nobody renews it
      await crashed.set("lock:bootstrap", "crashed-replica", "PX", 800);
      const t0 = Date.now();
      const r = await k.app.get(BootstrapService).run({
        manifest: fx.manifest,
        dir: fx.dir,
        imports: k.app.get(PluginImport),
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      expect(r.results).toEqual([{ name: "alpha", action: "installed", version: "1.0.0" }]);
    } finally {
      crashed.disconnect();
    }
  });

  it("stop() ends a start that waits for the bootstrap lock", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    // Another holder of `lock:bootstrap` (R5: the Redis lock, renewed by its holder)
    const holder = new Redis(rd.url);
    try {
      await holder.set("lock:bootstrap", "another-replica", "PX", 60_000);
      const config: KernelConfig = runConfig(
        { pg: pgc.url, redis: rd.url },
        { roles: ["api"], extensionHost: { dir: extensionsDir }, log: { level: "error" } },
      );
      const k = await buildKernel(config, {
        env: {},
        logger: createLogger("error"),
        bootstrap: { dir: fx.dir },
        bootstrapManifest: fx.manifest,
      });
      const started = k.start();
      started.catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const t0 = Date.now();
      await k.close();
      await expect(started).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await installs()).toEqual([]);
    } finally {
      await holder.del("lock:bootstrap");
      holder.disconnect();
    }
  });
});
