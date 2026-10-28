import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { bootstrapManifestSha256 } from "../../src/extensions/bootstrap.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { bootstrapFixture, packFake } from "../helpers/plugin-packages.js";
import { createOrg, PW, runConfig, session } from "../helpers/runs.js";

/**
 * Phase A acceptance (spec §12, §7 "Migration of existing deployments"): a deployment from before
 * bootstrap upgrades without losing its built-in extensions. A database is migrated through 0049
 * (`main` at 1461e27, the last commit with built-in extensions) and given what the built-in
 * model provider and object store left behind there: name owners, `builtin` replica status rows,
 * a deployment config stored in PG, an org — and no install records. Then the kernel of this
 * branch migrates (0050) and starts with the bootstrap directory: both plugins get bootstrap
 * install records, required and enabled in the existing org, and the object store loads with the
 * deployment config the admin had saved. The two plugins are the core fakes `fake-bootstrap-a`
 * (a model provider with a required secret, standing in for openai-compatible) and
 * `fake-bootstrap-b` (an object store in PG with a non-secret `bucket` and a secret `secretKey`,
 * standing in for object-store-s3), packed as the image packs its bootstrap plugins.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let extensionsDir: string;
let oldMigrations: string;
let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
let k: Kernel | undefined;
let orgId: string;

/** The object store's non-secret deployment config saved from the admin console before the upgrade. */
const BUCKET = "pre-upgrade";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // The migrations `main` had before bootstrap: 0001 to 0049
  oldMigrations = await mkdtemp(join(tmpdir(), "kernel-pre-bootstrap-migrations-"));
  for (const f of await readdir(KERNEL_MIGRATIONS_DIR)) {
    if (/^\d{4}_/.test(f) && Number(f.slice(0, 4)) <= 49) {
      await cp(join(KERNEL_MIGRATIONS_DIR, f), join(oldMigrations, f));
    }
  }
  await migrate(pgc.url, { schema: "capybara", dir: oldMigrations });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  extensionsDir = await mkdtemp(join(tmpdir(), "kernel-pre-bootstrap-ext-"));

  // What the built-in extensions left in a development deployment (checked against a database a
  // 1461e27 kernel ran on): the names claimed by their npm packages, one `builtin` status row each,
  // the object store's non-secret deployment config saved from the admin console, an org.
  await sql`
    INSERT INTO capybara.extension_name_owners (name, package_name) VALUES
      ('fake-bootstrap-a', '@capybara-hq/test-plugin-fake-bootstrap-a'),
      ('fake-bootstrap-b', '@capybara-hq/test-plugin-fake-bootstrap-b')
  `.execute(db);
  await sql`
    INSERT INTO capybara.extension_replica_status
      (replica_id, plugin, version, sha256, source, state, reason, heartbeat_at) VALUES
      ('old-replica', 'fake-bootstrap-b', '0.1.0', NULL, 'builtin', 'loaded', NULL, now()),
      ('old-replica', 'fake-bootstrap-a', '0.1.0', NULL, 'builtin', 'pending', 'config', now())
  `.execute(db);
  await sql`
    INSERT INTO capybara.extension_deployment_configs (plugin, config, updated_at) VALUES
      ('fake-bootstrap-b', ${JSON.stringify({ bucket: BUCKET })}::jsonb, now())
  `.execute(db);
  await new AccountsService(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  expect(
    (await sql<{ n: string }>`SELECT count(*) AS n FROM capybara.extension_installs`.execute(db))
      .rows[0]?.n,
  ).toBe("0");

  fx = await bootstrapFixture([
    { bytes: await packFake("fake-bootstrap-a") },
    { bytes: await packFake("fake-bootstrap-b") },
  ]);
}, 300_000);

afterAll(async () => {
  await k?.stop();
  await fx?.cleanup();
  await destroyDb?.();
  for (const d of [extensionsDir, oldMigrations]) {
    if (d) await rm(d, { recursive: true, force: true });
  }
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("a deployment from before bootstrap (built-in extensions, no install records)", () => {
  it("migrates through 0050 and bootstraps both plugins without losing their config", async () => {
    // A first kernel of the old code made the org; with the new code the org already exists
    const config: KernelConfig = runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        // Only the bootstrap plugins, as in a deployment from the image
        extensions: [],
        extensionHost: { dir: extensionsDir },
        extensionPermissions: { autoApprove: false },
        // The secrets come from the startup config (env in a real deployment); the rest is the
        // deployment config stored in PG before the upgrade
        extensionConfig: {
          "fake-bootstrap-b": { secretKey: "pre-upgrade-secret" },
        },
        log: { level: "error" },
      },
    );
    await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    // 0050 dropped the stale builtin status rows
    expect(await db.selectFrom("extension_replica_status").select("plugin").execute()).toEqual([]);

    k = await createKernel(config, {
      env: {},
      logger: createLogger("error"),
      bootstrap: { dir: fx.dir },
      bootstrapManifest: fx.manifest,
    });
    await k.start();
    const admin = await session(k, "root");
    orgId = await createOrg(admin, "Before");

    expect(
      await db
        .selectFrom("extension_installs")
        .select(["name", "version", "source", "desired_state", "required"])
        .orderBy("name")
        .execute(),
    ).toEqual([
      {
        name: "fake-bootstrap-a",
        version: "0.1.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: true,
      },
      {
        name: "fake-bootstrap-b",
        version: "0.1.0",
        source: "bootstrap",
        desired_state: "enabled",
        required: true,
      },
    ]);
    // The names stay with the same npm packages; the snapshots are the bootstrap's
    expect(
      await db
        .selectFrom("extension_name_owners")
        .select(["name", "package_name"])
        .orderBy("name")
        .execute(),
    ).toEqual([
      { name: "fake-bootstrap-a", package_name: "@capybara-hq/test-plugin-fake-bootstrap-a" },
      { name: "fake-bootstrap-b", package_name: "@capybara-hq/test-plugin-fake-bootstrap-b" },
    ]);
    expect(
      await db
        .selectFrom("extension_permission_snapshots")
        .select(["plugin", "source"])
        .orderBy("plugin")
        .execute(),
    ).toEqual([
      { plugin: "fake-bootstrap-a", source: "bootstrap" },
      { plugin: "fake-bootstrap-b", source: "bootstrap" },
    ]);
    expect(await k.bootstrap.isDone(bootstrapManifestSha256(fx.manifest))).toBe(true);

    // The object store loads with the config saved before the upgrade (approval is off, so this
    // also proves the bootstrap snapshot), and is usable
    expect(k.host.sourceOf("fake-bootstrap-b")).toBe("install");
    expect(k.storage.available).toBe(true);
    const view = await admin({
      method: "GET",
      url: "/api/v1/admin/extensions/fake-bootstrap-b/config",
    });
    expect(view.statusCode, view.body).toBe(200);
    const bucket = (view.json().fields as { path: string; source: string; value: unknown }[]).find(
      (f) => f.path === "bucket",
    );
    expect(bucket).toMatchObject({ source: "db", value: BUCKET });
    // the model provider has no deployment config: pending configuration, as it was before
    expect(
      await db
        .selectFrom("extension_replica_status")
        .select(["plugin", "source", "state", "reason"])
        .orderBy("plugin")
        .execute(),
    ).toEqual([
      { plugin: "fake-bootstrap-a", source: "install", state: "pending", reason: "config" },
      { plugin: "fake-bootstrap-b", source: "install", state: "loaded", reason: null },
    ]);

    // Still enabled in every org, and still not removable
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    const byName = new Map(
      (list.json().extensions as { plugin: string; enabled: boolean; required: boolean }[]).map(
        (p) => [p.plugin, p],
      ),
    );
    for (const name of ["fake-bootstrap-a", "fake-bootstrap-b"]) {
      expect(byName.get(name)).toMatchObject({ enabled: true, required: true });
    }
    const off = await admin({
      method: "POST",
      url: "/api/v1/admin/extensions/fake-bootstrap-b/disable",
    });
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json().error.code).toBe("extension.required");
  });
});
