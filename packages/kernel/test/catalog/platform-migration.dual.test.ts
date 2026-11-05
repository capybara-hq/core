import { randomUUID } from "node:crypto";
import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATION_JOB } from "../../src/catalog/platform-migration.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { waitFor } from "../helpers/runs.js";

/**
 * Dual replica (plugin scope phase 2, Task 5): the platform components migration runs at the
 * start of a worker (`@LockedInterval` with `runOnStart`). Two worker replicas starting together
 * run it once: one row in `platform_migration_runs`, the org copy linked once.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const manifest = (name: string) =>
  JSON.stringify({ name, description: `Use for ${name}.`, files: [] });

/**
 * An org with plugin `kit` on (a live install) whose platform skill `alpha` is on there, and the
 * org's copy of `alpha` from that plugin, not linked yet: the migration links it.
 */
async function seed(db: KernelSchemaDb): Promise<{ skillId: string; platformId: string }> {
  const orgId = randomUUID();
  await db
    .insertInto("orgs")
    .values({ id: orgId, slug: "dual", name: "Dual", created_by: null })
    .execute();
  const itemId = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id: itemId,
      name: "kit",
      package_name: "@acme/plugin-kit",
      publisher: "Acme",
      description: "Kit",
      latest_version: "1.0.0",
      policy: "allow",
      platform_synced_version: "1.0.0",
    })
    .execute();
  await db
    .insertInto("catalog_item_org_switches")
    .values({ item_id: itemId, org_id: orgId, enabled: true })
    .execute();
  await db
    .insertInto("plugin_installs")
    .values({
      id: randomUUID(),
      org_id: orgId,
      item_id: itemId,
      version: "1.0.0",
      status: "installed",
    })
    .execute();
  const platformId = randomUUID();
  await db
    .insertInto("platform_skills")
    .values({
      id: platformId,
      catalog_item_id: itemId,
      plugin_name: "kit",
      name: "alpha",
      description: "Use for alpha.",
      current_version: 1,
    })
    .execute();
  await db
    .insertInto("platform_skill_versions")
    .values({
      skill_id: platformId,
      version: 1,
      manifest: manifest("alpha"),
      object_prefix: `platform/skills/${platformId}/1/`,
      catalog_version: "1.0.0",
    })
    .execute();
  const skillId = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id: skillId,
      org_id: orgId,
      scope: "org",
      agent_id: null,
      name: "alpha",
      description: "Our alpha.",
      current_version: 1,
      created_by: null,
      catalog_item_id: itemId,
      catalog_version: "1.0.0",
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: skillId,
      version: 1,
      manifest: manifest("alpha"),
      object_prefix: `skills/${skillId}/1/`,
      created_by: null,
      catalog_item_id: itemId,
      catalog_version: "1.0.0",
    })
    .execute();
  return { skillId, platformId };
}

describe("platform components migration (dual replica)", () => {
  it("two worker replicas starting together run it once", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    raw = createDb(h.dbUrl, 3);
    const db = kernelDb(raw);
    // the base replicas' start run (nothing to do yet)
    await waitFor(
      async () =>
        (await db.selectFrom("platform_migration_runs").select("finished_at").execute()).some(
          (r) => r.finished_at !== null,
        ),
      30_000,
    );
    const before = (await db.selectFrom("platform_migration_runs").select("id").execute()).length;
    const { skillId, platformId } = await seed(db);

    // the start marker of the base replicas' start would hold back a start within its window
    const probe = new Redis(rdc.url);
    await probe.del(`cron:${PLATFORM_MIGRATION_JOB}:start`);
    probe.disconnect();
    await Promise.all([h.startExtraReplica(["worker"]), h.startExtraReplica(["worker"])]);

    await waitFor(async () => {
      const s = await db
        .selectFrom("skills")
        .select("platform_skill_id")
        .where("id", "=", skillId)
        .executeTakeFirstOrThrow();
      return s.platform_skill_id === platformId;
    }, 30_000);
    // a second start run, had there been one, would have written its row by now
    await new Promise((r) => setTimeout(r, 3_000));
    const runs = await db.selectFrom("platform_migration_runs").select("stats").execute();
    expect(runs).toHaveLength(before + 1);
    expect(
      runs.filter((r) => (r.stats as { skillsLinked?: number }).skillsLinked === 1),
    ).toHaveLength(1);
  }, 180_000);
});
