import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDualReplicaHarness, type Harness } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, lifePkg } from "../helpers/plugin-packages.js";
import { waitFor } from "../helpers/runs.js";

/**
 * Phase A2 Review Focus 1: two replicas start together on a fresh database with the same bootstrap
 * directory. The advisory lock lets one run the bootstrap step; the other waits, finds it done and
 * installs nothing; both end up loading the bootstrap plugins (permission approval is off, so
 * loading proves the bootstrap snapshot).
 */
describe("bootstrap with two replicas starting together", { timeout: 180_000 }, () => {
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let fx: Awaited<ReturnType<typeof bootstrapFixture>>;
  let extensionsDir: string;

  beforeAll(async () => {
    fx = await bootstrapFixture([
      { bytes: await lifePkg({ name: "alpha", version: "1.0.0" }) },
      { bytes: await lifePkg({ name: "beta", version: "1.0.0" }), required: false },
    ]);
    extensionsDir = await mkdtemp(join(tmpdir(), "cap-bootstrap-dual-"));
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE],
      bootstrap: fx,
      config: {
        extensionPermissions: { autoApprove: false },
        extensionHost: { dir: extensionsDir, reconcileIntervalSeconds: 2 },
      },
    });
    raw = createDb(h.dbUrl, 2);
    db = kernelDb(raw);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    await fx?.cleanup();
    if (extensionsDir) await rm(extensionsDir, { recursive: true, force: true });
  }, 120_000);

  it("runs once and both replicas load the plugins", async () => {
    expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toHaveLength(
      1,
    );
    const actions = async (action: string) =>
      (
        await db
          .selectFrom("audit_events")
          .select("target")
          .where("action", "=", action)
          .orderBy("target")
          .execute()
      ).map((r) => r.target);
    expect(await actions("bootstrap.completed")).toHaveLength(1);
    expect(await actions("extension.installed")).toEqual(["alpha", "beta"]);
    expect(await actions("catalog.imported")).toHaveLength(2);
    expect(
      await db
        .selectFrom("extension_installs")
        .select(["name", "source", "required", "desired_state"])
        .orderBy("name")
        .execute(),
    ).toEqual([
      { name: "alpha", source: "bootstrap", required: true, desired_state: "enabled" },
      { name: "beta", source: "bootstrap", required: false, desired_state: "enabled" },
    ]);
    // Both replicas report both plugins loaded (each replica writes its own status rows)
    await waitFor(
      async () => {
        const rows = await db
          .selectFrom("extension_replica_status")
          .select(["replica_id", "plugin", "state", "source"])
          .where("plugin", "in", ["alpha", "beta"])
          .execute();
        const loaded = rows.filter((r) => r.state === "loaded" && r.source === "install");
        return new Set(loaded.map((r) => r.replica_id)).size === 2 && loaded.length === 4;
      },
      30_000,
      "both replicas load alpha and beta",
    );
  });
});
