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
  BOOTSTRAP_LOCK_TTL,
  BootstrapFailedError,
  BootstrapService,
  bootstrapManifestSha256,
} from "../../src/extensions/bootstrap.js";
import { enabledExtensionsByOrg, isExtensionEnabled } from "../../src/extensions/enabled.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import type { KernelOverride } from "../../src/overrides.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
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
  seams: KernelOverride[] = [],
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
    overrides: seams,
  });
  kernels.push(k);
  await k.start();
  return k;
}
/**
 * A short `lock:bootstrap` TTL, so a run outlives it several times over. It renews every 500 ms and
 * gives up 1 s after its last good renewal: a loaded test worker's event-loop stalls stay far below
 * that (300 ms failed on stalls of about 100 ms).
 */
const shortLock: KernelOverride[] = [{ provide: BOOTSTRAP_LOCK_TTL, useValue: 1_500 }];

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
    "capybara.bootstrap_runs, capybara.catalog_files, capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.extension_name_owners, capybara.extension_org_configs, capybara.extension_catalog_sources, capybara.catalog_item_versions, capybara.catalog_items, capybara.plugin_import_staging, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
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
    superAdmin: true,
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

describe("a fresh deployment", { timeout: 30_000 }, () => {
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

  it("the required entry's item is builtin, scope all and pending until a person confirms it", async () => {
    const items = async () =>
      (await admin({ method: "GET", url: "/api/v1/admin/catalog/items" })).json().items as {
        id: string;
        name: string;
        builtin: boolean;
        scope: string;
        disabled: boolean;
        pending: boolean;
        permissionsHash: string | null;
      }[];
    const list = await items();
    const alpha = list.find((i) => i.name === "alpha");
    expect(alpha).toMatchObject({ builtin: true, scope: "all", disabled: false, pending: true });
    expect(list.find((i) => i.name === "beta")).toMatchObject({
      builtin: false,
      pending: false,
    });
    const pending = await admin({ method: "GET", url: "/api/v1/admin/catalog/items?pending=true" });
    expect(pending.json().items.map((i: { name: string }) => i.name)).toEqual(["alpha"]);
    const stale = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${alpha?.id}/confirm`,
      payload: { permissionsHash: "0000000000000000" },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("extension.approval_stale");
    const ok = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${alpha?.id}/confirm`,
      payload: { permissionsHash: alpha?.permissionsHash },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ pending: false, builtin: true });
    expect(await snapshot("alpha")).toMatchObject({ source: "web" });
    const again = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${alpha?.id}/confirm`,
      payload: { permissionsHash: alpha?.permissionsHash },
    });
    expect(again.json().error.code).toBe("extension.not_pending");
    // the confirmed snapshot is kept by the next run
    expect((await items()).find((i) => i.name === "alpha")?.pending).toBe(false);
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
      disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "alpha", name: "wait" }]),
    });
    expect(tools.tools.map((t) => t.key)).toEqual(["plugin__alpha__wait"]);
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

describe("a core upgrade (Review Focus 3)", { timeout: 30_000 }, () => {
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
    // The super admin disables delta and uninstalls epsilon (both optional)
    for (const [method, url] of [
      ["POST", "/api/v1/admin/extensions/delta/disable"],
      ["POST", "/api/v1/admin/extensions/epsilon/disable"],
      ["DELETE", "/api/v1/admin/extensions/epsilon"],
    ] as const) {
      const res = await admin({ method, url });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    }
    // The super admin upgrades beta by hand above what core pins
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
    // a required plugin the migration could have left disabled: the next run clears it
    await db
      .updateTable("catalog_items")
      .set({ disabled: true })
      .where("name", "=", "alpha")
      .execute();
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
    // gamma left the manifest: no longer builtin, still scope all
    expect(
      await db
        .selectFrom("catalog_items")
        .select(["name", "builtin", "scope", "disabled"])
        .where("name", "in", ["alpha", "gamma"])
        .orderBy("name")
        .execute(),
    ).toEqual([
      { name: "alpha", builtin: true, scope: "all", disabled: false },
      { name: "gamma", builtin: false, scope: "all", disabled: false },
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

describe("same version, different bytes", { timeout: 30_000 }, () => {
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
      get(t, k, receiver) {
        if (k === "warn") {
          return (msg: string, fields?: Record<string, unknown>) => {
            warns.push({ msg, ...(fields !== undefined && { fields }) });
          };
        }
        const v = Reflect.get(t, k);
        // children (each class's context logger) forward to the proxy
        return typeof v === "function" ? v.bind(k === "child" ? receiver : t) : v;
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
        fields: { plugin: "alpha", version: "1.0.0", context: "BootstrapService" },
      },
    ]);
  });
});

describe("a pin whose name an organization holds", { timeout: 30_000 }, () => {
  it("warns naming the plugin and the organization (P3-28)", async () => {
    await reset();
    // a later kernel release pins a plugin name an org uploaded meanwhile
    await db.insertInto("orgs").values({ id: "org-held", slug: "held", name: "Held" }).execute();
    await db
      .insertInto("catalog_items")
      .values({
        id: "00000000-0000-4000-8000-0000000000aa",
        name: "omega",
        package_name: "@held/omega",
        publisher: "Held",
        description: "omega",
        latest_version: "1.0.0",
        created_by: null,
        owner_org_id: "org-held",
      })
      .execute();
    const fx = await fixture([
      { bytes: await lifePkg({ name: "omega", version: "1.0.0" }), required: false },
    ]);
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const base = createLogger("error");
    const logger = new Proxy(base, {
      get(t, k, receiver) {
        if (k === "warn") {
          return (msg: string, fields?: Record<string, unknown>) => {
            warns.push({ msg, ...(fields !== undefined && { fields }) });
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(k === "child" ? receiver : t) : v;
      },
    });
    await boot(fx, {}, logger);
    // once per bootstrap attempt (the start retries a failed optional entry)
    const held = warns.filter((w) => w.msg.includes("held by an organization"));
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map((w) => JSON.stringify(w))).size).toBe(1);
    expect(held[0]).toEqual({
      msg: expect.stringContaining("bootstrap:"),
      fields: {
        plugin: "omega",
        version: "1.0.0",
        required: false,
        ownerOrgId: "org-held",
        ownerOrg: "Held",
        context: "BootstrapService",
      },
    });
  });
});

describe("the confirm's catalog view during bootstrap", { timeout: 30_000 }, () => {
  it("reads only the confirmed plugin's package: another unreadable package logs no admin-view warning", async () => {
    await reset();
    const v1 = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
    ]);
    await boot(v1);
    await stopAll();
    // beta's bytes are gone (as when the object store is not loaded yet during bootstrap)
    const beta = await db
      .selectFrom("extension_installs")
      .select("sha256")
      .where("name", "=", "beta")
      .executeTakeFirstOrThrow();
    await db.deleteFrom("extension_blobs").where("sha256", "=", beta.sha256).execute();
    const v2 = await fixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.1.0" }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }) },
    ]);
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const base = createLogger("error");
    const logger = new Proxy(base, {
      get(t, k, receiver) {
        if (k === "warn") {
          return (msg: string, fields?: Record<string, unknown>) => {
            warns.push({ msg, ...(fields !== undefined && { fields }) });
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(k === "child" ? receiver : t) : v;
      },
    });
    const k = await boot(v2, {}, logger);
    const r = (await audits("bootstrap.completed")).at(-1)?.detail as { results: unknown[] };
    expect(r.results).toEqual([
      { name: "alpha", action: "upgraded", version: "1.1.0" },
      { name: "beta", action: "kept", version: "1.0.0" },
    ]);
    expect(k.app.get(ExtensionHost).current("alpha")?.manifest.version).toBe("1.1.0");
    expect(warns.filter((w) => w.msg.includes("unreadable for the admin view"))).toEqual([]);
  });
});

describe("tampered and missing packages (Review Focus 2)", { timeout: 30_000 }, () => {
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

describe("obtaining the packages: offline directory, else npm (startup bootstrap spec)", {
  timeout: 30_000,
}, () => {
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

  /** The object store (required) and a builtin skill plugin, as npm entries. */
  const builtinFixture = async () =>
    fixture(
      [
        { bytes: await packFake("fake-bootstrap-b") },
        { bytes: await skillPkg("delta"), builtin: true },
      ],
      { source: "npm" },
    );

  it("two passes download each package once; a builtin entry only in the second pass", async () => {
    const fx = await builtinFixture();
    await serve(fx.packages);
    const k = await boot(fx, { ...OBJECT_STORE_CONFIG, packages: { npmRegistry: reg?.url } });
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      true,
    );
    expect(tarballs()).toEqual([
      "/@test/plugin-fake-bootstrap-b/-/plugin-fake-bootstrap-b-0.1.0.tgz",
      "/@test/plugin-delta/-/plugin-delta-1.0.0.tgz",
    ]);
  });

  it("a builtin entry whose download fails in the second pass: the start continues, the run stays not done", async () => {
    const fx = await builtinFixture();
    // The registry has the object store only
    await serve(fx.packages.filter((p) => p.name !== "@test/plugin-delta"));
    const { logger, lines } = recordingLogger();
    const k = await boot(
      fx,
      { ...OBJECT_STORE_CONFIG, packages: { npmRegistry: reg?.url } },
      logger,
    );
    expect(k.port).toBeGreaterThan(0);
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      false,
    );
    expect((await installs()).map((r) => r.name)).toEqual(["fake-bootstrap-b"]);
    const final = lines.find((l) => l.msg.includes("retried on the next start"));
    expect(final?.fields?.failures).toEqual([
      expect.objectContaining({
        name: "delta",
        required: false,
        code: "bootstrap.download_failed",
      }),
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

describe("a declarative entry", { timeout: 30_000 }, () => {
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

/** A declarative plugin shipping a skill (its files need the object store). */
const skillPkg = (name: string, version = "1.0.0") =>
  pluginTgz({
    manifest: { name, version },
    files: {
      "skills/hello/SKILL.md": "---\nname: hello\ndescription: Says hello.\n---\nSay hello.\n",
    },
  });

/** A logger that records error and warn lines and drops the rest. */
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

const OBJECT_STORE_CONFIG = {
  extensionConfig: { "fake-bootstrap-b": { bucket: "bootstrap", secretKey: "s3cret" } },
};

describe("a builtin entry", { timeout: 30_000 }, () => {
  afterAll(stopAll);
  type Item = { id: string; name: string; builtin: boolean; scope: string; disabled: boolean };
  const itemNamed = async (name: string) =>
    (
      (await admin({ method: "GET", url: "/api/v1/admin/catalog/items" })).json().items as Item[]
    ).find((i) => i.name === name);

  it("is skipped by the first pass, imported once the object store runs, builtin and locked on in orgs", async () => {
    await reset();
    // Listed before the object store: the first pass would fail it with storage.unavailable
    const fx = await fixture([
      { bytes: await skillPkg("delta"), builtin: true },
      { bytes: await packFake("fake-bootstrap-b") },
    ]);
    expect(fx.manifest.plugins[0]).toMatchObject({ required: false, builtin: true });
    const { logger, lines } = recordingLogger();
    const k = await boot(fx, OBJECT_STORE_CONFIG, logger);
    // Deferred, not failed: no entry failure and no "could not be installed" line in any pass
    expect(lines.filter((l) => l.msg.includes("could not be installed"))).toEqual([]);
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      true,
    );
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [
        { name: "delta", action: "imported", version: "1.0.0" },
        { name: "fake-bootstrap-b", action: "installed", version: "0.1.0" },
      ],
    });
    await loginAdmin(k);
    expect(await itemNamed("delta")).toMatchObject({
      builtin: true,
      scope: "all",
      disabled: false,
    });
    const orgId = await createOrg(admin, "Builtin");
    const item = (await itemNamed("delta")) as Item;
    const off = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/catalog/${item.id}/switch`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json().error.code).toBe("plugin.scope_locked");
  });

  it("a failing builtin entry does not stop the start; the run stays not done", async () => {
    await reset();
    const fx = await fixture([
      { bytes: await packFake("fake-bootstrap-b") },
      { bytes: await skillPkg("delta"), builtin: true },
    ]);
    // The pinned package holds another plugin than the entry names
    const wrong = await skillPkg("other");
    const delta = fx.manifest.plugins[1] as BootstrapManifest["plugins"][number];
    await writeFile(join(fx.dir, bootstrapFileName(delta)), wrong);
    delta.integrity = `sha512-${createHash("sha512").update(wrong).digest("base64")}`;
    const { logger, lines } = recordingLogger();
    const k = await boot(fx, OBJECT_STORE_CONFIG, logger);
    expect(k.port).toBeGreaterThan(0);
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      false,
    );
    expect((await installs()).map((r) => r.name)).toEqual(["fake-bootstrap-b"]);
    expect(
      lines.some((l) => l.level === "error" && l.msg.includes("retried on the next start")),
    ).toBe(true);
  });

  it("without a configured object store: skipped by the first pass, failed by the second, the start continues", async () => {
    await reset();
    const fx = await fixture([
      { bytes: await packFake("fake-bootstrap-b") },
      { bytes: await skillPkg("delta"), builtin: true },
    ]);
    const { logger, lines } = recordingLogger();
    // No extensionConfig: fake-bootstrap-b waits for its config, so no object store runs
    const k = await boot(fx, {}, logger);
    expect(k.port).toBeGreaterThan(0);
    expect(k.app.get(StorageService).available).toBe(false);
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      false,
    );
    // Tried once, by the second pass
    const failed = lines.filter((l) => l.msg.includes("a plugin could not be installed"));
    expect(failed.map((l) => l.fields?.plugin)).toEqual(["delta"]);
    expect(
      lines.find((l) => l.msg.includes("retried on the next start"))?.fields?.failures,
    ).toEqual([expect.objectContaining({ name: "delta", code: "storage.unavailable" })]);
  });

  it("an org-owned item named like the entry is never touched; the entry fails with plugin.name_taken", async () => {
    await reset();
    await db.insertInto("orgs").values({ id: "org-held", slug: "held", name: "Held" }).execute();
    await db
      .insertInto("catalog_items")
      .values({
        id: "00000000-0000-4000-8000-0000000000bb",
        name: "delta",
        package_name: "@held/delta",
        publisher: "Held",
        description: "delta",
        latest_version: "1.0.0",
        created_by: null,
        owner_org_id: "org-held",
      })
      .execute();
    const before = await db
      .selectFrom("catalog_items")
      .select(["builtin", "scope", "disabled", "scope_version", "updated_at"])
      .where("name", "=", "delta")
      .executeTakeFirstOrThrow();
    const fx = await fixture([
      { bytes: await packFake("fake-bootstrap-b") },
      { bytes: await skillPkg("delta"), builtin: true },
    ]);
    const { logger, lines } = recordingLogger();
    const k = await boot(fx, OBJECT_STORE_CONFIG, logger);
    expect(k.port).toBeGreaterThan(0);
    expect(
      await db
        .selectFrom("catalog_items")
        .select(["builtin", "scope", "disabled", "scope_version", "updated_at"])
        .where("name", "=", "delta")
        .execute(),
    ).toEqual([before]);
    expect(await k.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      false,
    );
    expect(
      lines.find((l) => l.msg.includes("retried on the next start"))?.fields?.failures,
    ).toEqual([expect.objectContaining({ name: "delta", code: "plugin.name_taken" })]);
  });

  it("a builtin entry a super admin removed is imported again by the next run", async () => {
    await reset();
    const fx = await fixture([
      { bytes: await packFake("fake-bootstrap-b") },
      { bytes: await skillPkg("delta"), builtin: true },
    ]);
    const k = await boot(fx, OBJECT_STORE_CONFIG);
    await loginAdmin(k);
    const item = (await itemNamed("delta")) as Item;
    const del = await admin({ method: "DELETE", url: `/api/v1/admin/catalog/items/${item.id}` });
    expect(del.statusCode, del.body).toBe(204);
    expect(await itemNamed("delta")).toBeUndefined();
    await stopAll();

    // A core upgrade: a new manifest (one more entry) runs the step again
    const extra = await fixture([
      { bytes: await lifePkg({ name: "epsilon", version: "1.0.0" }), required: false },
    ]);
    const epsilon = extra.manifest.plugins[0] as BootstrapManifest["plugins"][number];
    await writeFile(
      join(fx.dir, bootstrapFileName(epsilon)),
      await readFile(join(extra.dir, bootstrapFileName(epsilon))),
    );
    fx.manifest.plugins.push(epsilon);
    const k2 = await boot(fx, OBJECT_STORE_CONFIG);
    expect(await k2.app.get(BootstrapService).isDone(bootstrapManifestSha256(fx.manifest))).toBe(
      true,
    );
    admin = await session(k2, "root");
    expect(await itemNamed("delta")).toMatchObject({ builtin: true, scope: "all" });
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [
        { name: "fake-bootstrap-b", action: "kept" },
        { name: "delta", action: "imported", version: "1.0.0" },
        { name: "epsilon", action: "installed", version: "1.0.0" },
      ],
    });
  });
});

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

/**
 * fake-im (channel@1, with a setup guide) at `version`: with an icon and its guide, or (`bare`)
 * with neither, like the bootstrap plugins released before they shipped files.
 */
const imPkg = (version: string, bare = false) =>
  packFake("fake-im", async (dir) => {
    for (const file of ["package.json", join(".capybara-plugin", "plugin.json")]) {
      const path = join(dir, file);
      const json = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      json.version = version;
      if (file !== "package.json") {
        if (bare) delete json.setupGuides;
        else json.icon = "./icon.svg";
      }
      await writeFile(path, JSON.stringify(json, null, 2));
    }
    const src = join(dir, "src", "index.ts");
    await writeFile(
      src,
      (await readFile(src, "utf8")).replace('version: "0.1.0"', `version: "${version}"`),
    );
    if (bare) await rm(join(dir, "guides"), { recursive: true });
    else await writeFile(join(dir, "icon.svg"), ICON);
  });

describe("bootstrap plugins with an icon and setup guides, no object store", {
  timeout: 60_000,
}, () => {
  afterAll(stopAll);

  /** The item of fake-im, its icon and its guide as the super admin and an org read them. */
  async function expectFilesServed(k: TestKernel, version: string): Promise<void> {
    expect(k.app.get(StorageService).available).toBe(false);
    admin = await session(k, "root");
    const items = (await admin({ method: "GET", url: "/api/v1/admin/catalog/items" })).json()
      .items as { id: string; name: string; latestVersion: string }[];
    const item = items.find((i) => i.name === "fake-im");
    expect(item).toBeDefined();
    const id = item?.id as string;
    const icon = await admin({ method: "GET", url: `/api/v1/admin/catalog/items/${id}/icon` });
    expect(icon.statusCode, icon.body).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    expect(icon.body).toBe(ICON);
    const orgId = await createOrg(admin, `Org ${version}`);
    const orgIcon = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/catalog/${id}/icon` });
    expect(orgIcon.statusCode, orgIcon.body).toBe(200);
    const guide = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/catalog/${id}/guides/fake-im-app?mode=webhook`,
    });
    expect(guide.statusCode, guide.body).toBe(200);
    const g = guide.json().guide as { version: string; blocks: { kind: string; text?: string }[] };
    expect(g.version).toBe(version);
    const code = g.blocks.filter((b) => b.kind === "code");
    expect(code).toHaveLength(1);
    expect(code[0]?.text?.length).toBeGreaterThan(0);
    // the bytes are in PG, keyed by the sha256 the version row records
    const v = await db
      .selectFrom("catalog_item_versions")
      .select(["files", "object_prefix"])
      .where("item_id", "=", id)
      .where("version", "=", version)
      .executeTakeFirstOrThrow();
    expect(v.object_prefix).toBeNull();
    const shas = (v.files as { sha256: string }[]).map((f) => f.sha256);
    expect(shas.length).toBe(3);
    const stored = await db
      .selectFrom("catalog_files")
      .select("sha256")
      .where("sha256", "in", shas)
      .execute();
    expect(stored).toHaveLength(new Set(shas).size);
  }

  it("a fresh deployment starts, and the item's icon and guide render", async () => {
    await reset();
    const fx = await fixture([{ bytes: await imPkg("0.2.0"), required: true }]);
    const k = await boot(fx);
    await loginAdmin(k);
    await expectFilesServed(k, "0.2.0");
  });

  it("an upgrade from a version without files stores them on the next manifest", async () => {
    await reset();
    const v1 = await fixture([{ bytes: await imPkg("0.1.0", true), required: true }]);
    await boot(v1);
    await stopAll();
    const v2 = await fixture([{ bytes: await imPkg("0.2.0"), required: true }]);
    const k = await boot(v2);
    await loginAdmin(k);
    expect((await installs()).map((r) => [r.name, r.version])).toEqual([["fake-im", "0.2.0"]]);
    await expectFilesServed(k, "0.2.0");
  });
});

describe("config-declared names and the lock", { timeout: 30_000 }, () => {
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
    // the lock's TTL is 1.5 s (BOOTSTRAP_LOCK_TTL)
    const k = await boot(undefined, {}, createLogger("error"), shortLock);
    const probe = new Redis(rd.url);
    const bootstrap = k.app.get(BootstrapService);
    let running: Promise<unknown> | undefined;
    try {
      const imports = {
        prepare: async (...a: Parameters<PluginImport["prepare"]>) => {
          // the run outlives the TTL several times over
          await new Promise((r) => setTimeout(r, 6_000));
          return k.app.get(PluginImport).prepare(...a);
        },
        confirm: (...a: Parameters<PluginImport["confirm"]>) =>
          k.app.get(PluginImport).confirm(...a),
      };
      const run = bootstrap.run({ manifest: fx.manifest, dir: fx.dir, imports });
      running = run;
      // twice the TTL: the key is still there only because it was renewed
      await new Promise((r) => setTimeout(r, 3_000));
      expect(await probe.exists("lock:bootstrap")).toBe(1);
      expect(await probe.set("lock:bootstrap", "other", "PX", 1_000, "NX")).toBeNull();
      const r = await run;
      expect(r.results).toEqual([{ name: "alpha", action: "installed", version: "1.0.0" }]);
      expect(await probe.exists("lock:bootstrap")).toBe(0);
    } finally {
      // a failed assertion must not leave the run writing after the kernel closes
      await running?.catch(() => {});
      probe.disconnect();
    }
  });

  it("a run that loses lock:bootstrap mid-run rejects naming the lock and records nothing as done", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    // the lock's TTL is 1.5 s (BOOTSTRAP_LOCK_TTL)
    const k = await boot(undefined, {}, createLogger("error"), shortLock);
    const probe = new Redis(rd.url);
    const bootstrap = k.app.get(BootstrapService);
    try {
      const imports = {
        prepare: async (...a: Parameters<PluginImport["prepare"]>) => {
          // another holder takes the key while the run is busy: the next renewal (500 ms) fails
          await probe.set("lock:bootstrap", "another-replica", "PX", 10_000);
          await new Promise((r) => setTimeout(r, 1_500));
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
    // Another holder of `lock:bootstrap` (the Redis lock, renewed by its holder)
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
