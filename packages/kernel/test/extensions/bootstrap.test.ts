import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BootstrapManifest, bootstrapFileName } from "@capybara-hq/plugin-sdk";
import {
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { BootstrapFailedError, bootstrapManifestSha256 } from "../../src/extensions/bootstrap.js";
import { enabledExtensionsByOrg, isExtensionEnabled } from "../../src/extensions/enabled.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  bootstrapFixture,
  lifePkg,
  packOfficialPlugin,
  pluginTgz,
} from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, runConfig, session } from "../helpers/runs.js";

const PERM_A = fileURLToPath(new URL("../fixtures/plugins/perm-a/index.ts", import.meta.url));

/**
 * The bootstrap step (package ecosystem spec §7, phase A2 Review Focus 2-4): what each manifest
 * entry turns into, re-runs, a core upgrade, tampered or missing packages, and the required plugins
 * every org gets without config rows. Kernels run with `extensionPermissions.autoApprove: false`, so
 * a loaded bootstrap plugin proves its permissions were pre-approved.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let extensionsDir: string;
const cleanups: (() => Promise<void>)[] = [];

const kernels: Kernel[] = [];
async function boot(
  fx: { dir: string; manifest: BootstrapManifest } | undefined,
  overrides: Record<string, unknown> = {},
): Promise<Kernel> {
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
  const k = await createKernel(config, {
    env: {},
    logger: createLogger("error"),
    ...(fx !== undefined && { bootstrapDir: fx.dir, bootstrapManifest: fx.manifest }),
  });
  kernels.push(k);
  await k.start();
  return k;
}
async function stopAll(): Promise<void> {
  while (kernels.length > 0) await kernels.pop()?.stop();
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
async function loginAdmin(k: Kernel): Promise<void> {
  await new AccountsService(db).createLocal({
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
  let k: Kernel;
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
    expect(k.host.current("alpha")?.manifest.version).toBe("1.0.0");
    expect(k.host.current("beta")?.manifest.version).toBe("1.0.0");
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
    expect(await k.bootstrap.isDone(sha)).toBe(true);
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
    const r = await k.bootstrap.run({ manifest: fx.manifest, dir: fx.dir });
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
    const enabled = await k.host.enabledPlugins(orgId);
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
    const tools = await k.tools.registry.forAgent(orgId, {
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
    expect(k.host.current("delta")).toBeUndefined();
    expect(k.host.current("epsilon")).toBeUndefined();
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
    expect(k.host.current("alpha")?.manifest.version).toBe("1.1.0");
    expect(k.host.current("beta")?.manifest.version).toBe("1.2.0");
    expect(k.host.current("gamma")?.manifest.version).toBe("1.0.0");
    // gamma is an ordinary install now: it can be disabled
    admin = await session(k, "root");
    const off = await admin({ method: "POST", url: "/api/v1/admin/extensions/gamma/disable" });
    expect(off.statusCode, off.body).toBe(200);
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

  it("one changed byte: refused naming the plugin, nothing installed, the kernel does not start", async () => {
    const fx = await tampered();
    await expect(boot(fx)).rejects.toMatchObject({
      code: "bootstrap.integrity_mismatch",
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
    await expect(k.bootstrap.run({ manifest: fx.manifest, dir: other })).rejects.toMatchObject({
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
    expect(k.host.current("alpha")).toBeDefined();
    expect(await k.bootstrap.isDone(bootstrapManifestSha256(fx.manifest))).toBe(false);

    // Fixed in a later image: the next start completes it
    await stopAll();
    const fixed = await lifePkg({ name: "beta", version: "1.0.0" });
    await writeFile(join(fx.dir, bootstrapFileName(beta)), fixed);
    beta.integrity = `sha512-${createHash("sha512").update(fixed).digest("base64")}`;
    const k2 = await boot(fx);
    expect(await k2.bootstrap.isDone(bootstrapManifestSha256(fx.manifest))).toBe(true);
    expect((await installs()).map((r) => [r.name, r.version])).toEqual([
      ["alpha", "1.0.0"],
      ["beta", "1.0.0"],
    ]);
  });
});

describe("a declarative entry", () => {
  let s3: TestS3;
  beforeAll(async () => {
    s3 = await startTestS3();
  }, 120_000);
  afterAll(async () => {
    await stopAll();
    await s3?.stop();
  });

  it("goes to the catalog only, once the object store (a bootstrap plugin itself) has loaded", async () => {
    await reset();
    const fx = await fixture([
      { bytes: await packOfficialPlugin("object-store-s3") },
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
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    });
    expect(k.storage.available).toBe(true);
    expect((await installs()).map((r) => [r.name, r.source, r.required])).toEqual([
      ["object-store-s3", "bootstrap", true],
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
    expect(await k.bootstrap.isDone(bootstrapManifestSha256(fx.manifest))).toBe(true);
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [
        { name: "object-store-s3", action: "installed", version: "0.1.0" },
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
    expect(k.host.sourceOf("perm-a")).toBe("config");
    expect(await installs()).toEqual([]);
    expect((await audits("bootstrap.completed")).at(-1)?.detail).toMatchObject({
      results: [{ name: "perm-a", action: "kept", version: "1.0.0" }],
    });
  });

  it("stop() ends a start that waits for the bootstrap lock", async () => {
    const fx = await fixture([{ bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) }]);
    const holder = new pg.Client({ connectionString: pgc.url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('capybara.bootstrap'))");
      const config: KernelConfig = runConfig(
        { pg: pgc.url, redis: rd.url },
        { roles: ["api"], extensionHost: { dir: extensionsDir }, log: { level: "error" } },
      );
      const k = await createKernel(config, {
        env: {},
        logger: createLogger("error"),
        bootstrapDir: fx.dir,
        bootstrapManifest: fx.manifest,
      });
      const started = k.start();
      started.catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const t0 = Date.now();
      await k.stop();
      await expect(started).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await installs()).toEqual([]);
    } finally {
      await holder.end();
    }
  });
});
