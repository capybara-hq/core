import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionAdminOps } from "../../src/extensions/admin-ops.js";
import {
  BootstrapFailedError,
  BootstrapService,
  bootstrapManifestSha256,
} from "../../src/extensions/bootstrap.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionLifecycle } from "../../src/extensions/lifecycle.js";
import { ReplicaStatusStore } from "../../src/extensions/sources.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { bootstrapFixture, lifePkg, packFake } from "../helpers/plugin-packages.js";
import {
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * One enabled provider per single-provider extension point (maintainer decision 2026-11-08):
 * enabling a second sandbox is refused until the first is disabled; concurrent enables of two
 * providers let one through; bootstrap preinstalls a second one disabled; two enabled providers
 * left from before the rule load the earliest enabled on every replica and after every restart.
 */

const MAX_BYTES = 4 * 1024 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let pluginsDir: string;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let k: TestKernel;
let admin: Req;
const extra: TestKernel[] = [];

interface View {
  name: string;
  status: string;
  desired: { state: string } | null;
  replicas: { replicaId: string; state: string; reason: string | null }[];
  conflict?: {
    extensionPoint: string;
    providers: { name: string }[];
    unprovided?: true;
  };
  enableBlocked?: {
    extensionPoint: string;
    enabled: { name: string; displayName: unknown };
    required?: true;
  };
}

const config = (roles: ("api" | "worker")[]) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles,
      extensions: [],
      extensionPermissions: { autoApprove: true },
      extensionHost: { dir: pluginsDir, drainSeconds: 5, reconcileIntervalSeconds: 3600 },
      packages: { maxBytes: MAX_BYTES },
    },
  );

const post = (path: string, payload?: Record<string, unknown>) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/extensions/${path}`,
    ...(payload !== undefined && { payload }),
  });
const view = async (name: string, req: Req = admin) => {
  const res = await req({ method: "GET", url: `/api/v1/admin/extensions/${name}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as View;
};
const upload = async (bytes: Uint8Array) => {
  const up = await admin({
    method: "POST",
    url: "/api/v1/admin/extensions/packages/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(up.statusCode, up.body).toBe(200);
  return (up.json() as { sha256: string }).sha256;
};
const approve = async (name: string) => {
  // autoApprove is a startup thing; approve through the console as a super admin would
  const v = (await view(name)) as View & { sha256: string; reviewHash: string };
  const ok = await post(`${name}/approve`, { sha256: v.sha256, reviewHash: v.reviewHash });
  expect([200, 409], ok.body).toContain(ok.statusCode);
};
const install = async (name: string, provides: string[] = ["sandbox@2"], version = "1.0.0") => {
  const sha256 = await upload(await lifePkg({ name, version, provides }));
  const res = await post(`${name}/install`, { sha256 });
  expect(res.statusCode, res.body).toBe(200);
  await approve(name);
  return res.json() as View & { leftDisabled?: unknown };
};
const setRow = (name: string, enabledAt: string | null) =>
  db
    .updateTable("extension_installs")
    .set({
      desired_state: enabledAt === null ? "disabled" : "enabled",
      enabled_at: enabledAt === null ? null : (sql<Date>`${sql.raw(enabledAt)}` as unknown as Date),
    })
    .where("name", "=", name)
    .execute();
const desiredOf = (name: string) =>
  db
    .selectFrom("extension_installs")
    .select(["desired_state", "enabled_at"])
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
const enable = (name: string) => post(`${name}/enable`);
const disable = async (name: string) => {
  const res = await post(`${name}/disable`);
  expect(res.statusCode, res.body).toBe(200);
};
const loaded = (kernel: TestKernel, name: string) =>
  kernel.app.get(ExtensionHost).current(name)?.version;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-single-provider-"));
  bootstrap = await bootstrapFixture([{ bytes: await packFake("fake-bootstrap-b") }]);
  await truncateTables(
    db,
    "capybara.extension_replica_status, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_permission_snapshots, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  k = await startKernel(config(["api", "worker"]), {
    bootstrap: { dir: bootstrap.dir },
    bootstrapManifest: bootstrap.manifest,
  });
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    superAdmin: true,
  });
  admin = await session(k, "root");
});

afterAll(async () => {
  for (const x of extra) await x.close().catch(() => {});
  await k?.close();
  await destroyDb?.();
  await rm(pluginsDir, { recursive: true, force: true });
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

// The cases run in order: each starts from the state the previous one left.
describe("single-provider extension points: one enabled provider", () => {
  it("enabling a second sandbox is refused (409, actionable) and allowed once the first is disabled", async () => {
    await install("sbx-a");
    await install("sbx-b");
    const a = await enable("sbx-a");
    expect(a.statusCode, a.body).toBe(200);
    await waitFor(async () => loaded(k, "sbx-a") === "1.0.0", 15_000, "sbx-a loaded");

    // The view says so before anyone tries
    expect((await view("sbx-b")).enableBlocked).toEqual({
      extensionPoint: "sandbox@2",
      enabled: { name: "sbx-a", displayName: null },
    });
    const refused = await enable("sbx-b");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toEqual({
      code: "extension.single_provider_enabled",
      message: "Only one extension may provide sandbox@2; disable sbx-a first, then enable sbx-b",
      details: [{ extensionPoint: "sandbox@2", enabled: { name: "sbx-a", displayName: null } }],
    });
    const row = await db
      .selectFrom("extension_installs")
      .select(["desired_state", "enabled_at"])
      .where("name", "=", "sbx-b")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ desired_state: "disabled", enabled_at: null });
    expect(loaded(k, "sbx-b")).toBeUndefined();

    // Switch: disable the current one first, then enable the other
    await disable("sbx-a");
    expect((await view("sbx-b")).enableBlocked).toBeUndefined();
    const b = await enable("sbx-b");
    expect(b.statusCode, b.body).toBe(200);
    await waitFor(async () => loaded(k, "sbx-b") === "1.0.0", 15_000, "sbx-b loaded");
    await waitFor(async () => loaded(k, "sbx-a") === undefined, 15_000, "sbx-a unloaded");
    await disable("sbx-b");
    await waitFor(async () => loaded(k, "sbx-b") === undefined, 15_000, "sbx-b unloaded");
  });

  it("two concurrent enables of different providers: exactly one wins", async () => {
    // The CLI's path (no actor): no super admin row lock serializes the two, only the point's lock
    const ops = k.app.get(ExtensionAdminOps);
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled([
        ops.enable("sbx-a", null),
        ops.enable("sbx-b", null),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ApiError);
      expect((lost.reason as ApiError).code).toBe("extension.single_provider_enabled");
      const enabled = await db
        .selectFrom("extension_installs")
        .select("name")
        .where("name", "in", ["sbx-a", "sbx-b"])
        .where("desired_state", "=", "enabled")
        .execute();
      expect(enabled).toHaveLength(1);
      await disable(enabled[0]?.name as string);
    }
    await waitFor(
      async () => loaded(k, "sbx-a") === undefined && loaded(k, "sbx-b") === undefined,
      15_000,
      "both unloaded",
    );
  });

  it("two enabled providers left from before the rule: the earliest enabled loads, on a running replica, after a restart and on a second replica", async () => {
    // sbx-b (sorted after sbx-a) was enabled first; sbx-a later, written straight to PG as an
    // older kernel let it happen. The running replica loaded sbx-a when it was alone.
    await enable("sbx-a").then((r) => expect(r.statusCode, r.body).toBe(200));
    await waitFor(async () => loaded(k, "sbx-a") === "1.0.0", 15_000, "sbx-a loaded");
    await db
      .updateTable("extension_installs")
      .set({
        desired_state: "enabled",
        enabled_at: sql<Date>`now() - interval '1 day'` as unknown as Date,
      })
      .where("name", "=", "sbx-b")
      .execute();

    // The running replica converges to the same choice, not to what it happened to load first
    await k.app.get(ExtensionLifecycle).reconcile("test");
    await waitFor(async () => loaded(k, "sbx-b") === "1.0.0", 15_000, "sbx-b loaded");
    expect(loaded(k, "sbx-a")).toBeUndefined();
    await waitFor(async () => (await view("sbx-a")).status === "conflict", 10_000, "conflict");
    const a = await view("sbx-a");
    expect(a.conflict).toEqual({
      extensionPoint: "sandbox@2",
      providers: [{ name: "sbx-b", displayName: null }],
    });

    // A restart and a second replica (both start from PG): the same provider, never name order
    const k2 = await startKernel(config(["api"]));
    extra.push(k2);
    const k3 = await startKernel(config(["api"]));
    extra.push(k3);
    for (const kernel of [k2, k3]) {
      expect(loaded(kernel, "sbx-b")).toBe("1.0.0");
      expect(loaded(kernel, "sbx-a")).toBeUndefined();
    }
    const ids = [k, k2, k3].map((x) => x.app.get(ReplicaStatusStore).replicaId);
    await waitFor(
      async () => {
        const v = await view("sbx-a");
        return ids.every((id) =>
          v.replicas.some(
            (r) => r.replicaId === id && r.state === "pending" && r.reason === "conflict",
          ),
        );
      },
      10_000,
      "every replica marks sbx-a conflict",
    );

    // Disabling the loaded one hands the point to the other everywhere
    await disable("sbx-b");
    await k.app.get(ExtensionLifecycle).reconcile("test");
    await waitFor(async () => loaded(k, "sbx-a") === "1.0.0", 15_000, "sbx-a loaded again");
    for (const x of extra.splice(0)) await x.close();
  });

  it("bootstrap: a new preinstall providing an occupied single point is installed disabled", async () => {
    // sbx-a is enabled (previous case). A later image adds an optional sandbox preinstall.
    const boot = await bootstrapFixture([
      { bytes: await packFake("fake-bootstrap-b") },
      {
        bytes: await lifePkg({ name: "sbx-boot", version: "1.0.0", provides: ["sandbox@2"] }),
        required: false,
      },
    ]);
    try {
      const k4 = await startKernel(config(["api"]), {
        bootstrap: { dir: boot.dir },
        bootstrapManifest: boot.manifest,
      });
      extra.push(k4);
      const row = await db
        .selectFrom("extension_installs")
        .select("desired_state")
        .where("name", "=", "sbx-boot")
        .executeTakeFirstOrThrow();
      expect(row.desired_state).toBe("disabled");
      expect(loaded(k4, "sbx-boot")).toBeUndefined();
      expect(loaded(k4, "sbx-a")).toBe("1.0.0");
      expect((await view("sbx-boot")).enableBlocked?.enabled.name).toBe("sbx-a");
      for (const x of extra.splice(0)) await x.close();
    } finally {
      await boot.cleanup();
    }
  });

  it("the elected provider does not load: the point has no provider and the views say so", async () => {
    // sbx-w was enabled before sbx-a (left from before the rule) but its package bytes are gone,
    // so it cannot load; the election still picks it on every replica
    const sha256 = await upload(
      await lifePkg({ name: "sbx-w", version: "1.0.0", provides: ["sandbox@2"] }),
    );
    expect((await post("sbx-w/install", { sha256 })).statusCode).toBe(200);
    await db.deleteFrom("extension_blobs").where("sha256", "=", sha256).execute();
    await setRow("sbx-w", "now() - interval '2 days'");
    await k.app.get(ExtensionLifecycle).reconcile("test");
    await waitFor(async () => loaded(k, "sbx-a") === undefined, 15_000, "sbx-a unloaded");
    expect(loaded(k, "sbx-w")).toBeUndefined();
    await waitFor(
      async () => (await view("sbx-a")).conflict?.unprovided === true,
      10_000,
      "sbx-a says the point has no running provider",
    );
    const a = await view("sbx-a");
    expect(a.conflict).toEqual({
      extensionPoint: "sandbox@2",
      providers: [{ name: "sbx-w", displayName: null }],
      unprovided: true,
    });
    const detail = a.replicas.find((r) => r.state === "pending") as unknown as { detail: string };
    expect(detail.detail).toBe(
      "extension point sandbox@2 is single-provider but provided by: sbx-w, sbx-a; sbx-w is not loaded, so sandbox@2 has no running provider",
    );
    // Put back: sbx-w disabled, sbx-a loads again
    await setRow("sbx-w", null);
    await k.app.get(ExtensionLifecycle).reconcile("test");
    await waitFor(async () => loaded(k, "sbx-a") === "1.0.0", 15_000, "sbx-a loaded again");
    expect((await view("sbx-a")).conflict).toBeUndefined();
  });

  it("the occupant named is the elected holder: A holds sandbox, B (sandbox + secret-store) lost, C holds secret-store", async () => {
    await install("multi-b", ["sandbox@2", "secret-store@1"]);
    await install("sec-c", ["secret-store@1"]);
    await install("sec-d", ["secret-store@1"]);
    // Written straight to PG, as an older kernel let it happen; no reconcile runs
    const a = await desiredOf("sbx-a");
    const at = (a.enabled_at as Date).toISOString();
    await setRow("multi-b", `'${at}'::timestamptz + interval '1 second'`);
    await setRow("sec-c", `'${at}'::timestamptz + interval '2 seconds'`);
    try {
      expect((await view("sec-d")).enableBlocked).toEqual({
        extensionPoint: "secret-store@1",
        enabled: { name: "sec-c", displayName: null },
      });
      const refused = await enable("sec-d");
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toBe(
        "Only one extension may provide secret-store@1; disable sec-c first, then enable sec-d",
      );
    } finally {
      await setRow("multi-b", null);
      await setRow("sec-c", null);
    }
  });

  it("an upgrade that newly provides an occupied single point installs it disabled and says why; the provider running stays", async () => {
    await install("x-up", []);
    expect((await enable("x-up")).statusCode).toBe(200);
    await waitFor(async () => loaded(k, "x-up") === "1.0.0", 15_000, "x-up loaded");
    const sha256 = await upload(
      await lifePkg({ name: "x-up", version: "2.0.0", provides: ["sandbox@2"] }),
    );
    const res = await post("x-up/install", { sha256 });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { leftDisabled?: unknown }).leftDisabled).toEqual({
      code: "extension.single_provider_enabled",
      message: "Only one extension may provide sandbox@2; disable sbx-a first, then enable x-up",
      singleProvider: {
        extensionPoint: "sandbox@2",
        enabled: { name: "sbx-a", displayName: null },
      },
    });
    expect(await desiredOf("x-up")).toEqual({ desired_state: "disabled", enabled_at: null });
    await waitFor(async () => loaded(k, "x-up") === undefined, 15_000, "x-up unloaded");
    expect(loaded(k, "sbx-a")).toBe("1.0.0");
    expect((await desiredOf("sbx-a")).desired_state).toBe("enabled");
  });

  it("bootstrap: a required entry whose single point is occupied fails the run, which is not recorded done", async () => {
    const boot = await bootstrapFixture([
      { bytes: await packFake("fake-bootstrap-b") },
      {
        bytes: await lifePkg({ name: "sbx-req", version: "1.0.0", provides: ["sandbox@2"] }),
        required: true,
      },
    ]);
    const bs = k.app.get(BootstrapService);
    const run = () =>
      bs.run({ manifest: boot.manifest, dir: boot.dir, imports: k.app.get(PluginImport) });
    try {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BootstrapFailedError);
      const failed = err as BootstrapFailedError;
      expect(failed.requiredFailed).toBe(true);
      expect(failed.failures).toEqual([
        {
          name: "sbx-req",
          required: true,
          code: "extension.single_provider_enabled",
          message:
            "Required plugin sbx-req provides sandbox@2, which sbx-a already provides; disable sbx-a and run the bootstrap again",
        },
      ]);
      expect(await bs.isDone(bootstrapManifestSha256(boot.manifest))).toBe(false);
      expect(loaded(k, "sbx-a")).toBe("1.0.0");

      // The super admin disables sbx-a and runs the bootstrap again: the required one is enabled
      await disable("sbx-a");
      await run();
      expect(await bs.isDone(bootstrapManifestSha256(boot.manifest))).toBe(true);
      expect((await desiredOf("sbx-req")).desired_state).toBe("enabled");
    } finally {
      await boot.cleanup();
    }
  });

  it("a required provider cannot be replaced: a distinct refusal, not a loop through disable", async () => {
    // sbx-req (required, previous case) holds sandbox@2
    expect((await view("sbx-b")).enableBlocked).toEqual({
      extensionPoint: "sandbox@2",
      enabled: { name: "sbx-req", displayName: null },
      required: true,
    });
    const refused = await enable("sbx-b");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toEqual({
      code: "extension.single_provider_required",
      message: "sandbox@2 is provided by the required plugin sbx-req; it can't be replaced",
      details: [
        {
          extensionPoint: "sandbox@2",
          enabled: { name: "sbx-req", displayName: null },
          required: true,
        },
      ],
    });
  });
});
