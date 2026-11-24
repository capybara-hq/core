import { randomUUID } from "node:crypto";
import {
  createDualReplicaHarness,
  fakeExtensionEntry,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_CONNECTOR_RECONCILE_SETTING } from "../../src/catalog/template-connector-reconcile.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { CONNECTOR_TOOLS_QUEUE } from "../../src/tools/connector-tools-jobs.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { enableExtensions } from "../helpers/runs.js";
import { mcpTemplate } from "./packages.js";

/**
 * Plugin pages spec §7 "Plugins waiting today": a plugin installed before phase 2 whose connector
 * template that is on has no connector gets it from a one-off reconciliation at startup, run once
 * across replicas (under `lock:bootstrap`). Two replicas start together on a database seeded with
 * such an install: exactly one connector is created; restarts create nothing more (also when the
 * pass runs again), and the reconciliation does not run again once done (a connector an admin
 * deletes later stays deleted).
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const ALL_ROLES = ["api", "worker", "gateway"];

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
});

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

/**
 * An org with the plugin `google` installed (the state an install left before phase 2): its
 * connector template `gmail` is on (it follows the plugin) and has no connector in the org.
 */
async function seedInstalledWithoutTemplateConnector(
  db: KernelSchemaDb,
  orgId: string,
  plugin: string,
  templateId: string,
): Promise<void> {
  const itemId = randomUUID();
  await db.insertInto("orgs").values({ id: orgId, slug: "acme", name: "Acme" }).execute();
  // the template's connector extension is on in the org
  await enableExtensions(db, orgId, "fake-connector");
  await db
    .insertInto("catalog_items")
    .values({
      id: itemId,
      name: plugin,
      package_name: `@acme/plugin-${plugin}`,
      publisher: "Acme",
      description: "Mail",
      latest_version: "1.0.0",
      platform_synced_version: "1.0.0",
    })
    .execute();
  await db
    .insertInto("catalog_item_versions")
    .values({
      item_id: itemId,
      version: "1.0.0",
      manifest: JSON.stringify({
        schemaVersion: 1,
        name: plugin,
        version: "1.0.0",
        publisher: "Acme",
        description: "Mail",
        skills: [],
        connectorTemplates: [{ path: `./connectors/${templateId}.json` }],
      }),
      source: "file",
      source_ref: "upload",
      object_prefix: null,
      files: JSON.stringify([]),
      size: 10,
    })
    .execute();
  await db
    .insertInto("platform_connector_templates")
    .values({
      id: randomUUID(),
      catalog_item_id: itemId,
      template_id: templateId,
      current_version: "1.0.0",
      file: JSON.stringify({ displayName: { zh: "Gmail", en: "Gmail" }, template: mcpTemplate() }),
    })
    .execute();
  await db
    .insertInto("plugin_installs")
    .values({
      id: randomUUID(),
      org_id: orgId,
      item_id: itemId,
      version: "1.0.0",
      status: "installed",
      installed_by: null,
    })
    .execute();
}

/** The org's live connectors made from template `templateId`. */
async function templateConnectors(
  db: KernelSchemaDb,
  orgId: string,
  templateId: string,
): Promise<{ id: string }[]> {
  return db
    .selectFrom("connectors as c")
    .innerJoin("platform_connector_templates as p", "p.id", "c.platform_template_id")
    .select("c.id")
    .where("c.org_id", "=", orgId)
    .where("c.deleted_at", "is", null)
    .where("p.template_id", "=", templateId)
    .execute();
}

/** Stops replica `index` and starts another in its place, once it is ready. */
async function restart(harness: Harness, index: number): Promise<void> {
  await harness.stopReplica(index);
  await harness.startExtraReplica(ALL_ROLES);
}

describe("template connector reconciliation at startup (dual replica)", () => {
  it("two replicas starting with a plugin missing a template connector create exactly one", async () => {
    const orgId = randomUUID();
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, CONNECTOR],
      extensionConfig: { "fake-connector": {} },
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      beforeStart: async (dbUrl) => {
        await migrate(dbUrl, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
        const seed = createDb(dbUrl, 1);
        try {
          await seedInstalledWithoutTemplateConnector(kernelDb(seed), orgId, "google", "gmail");
        } finally {
          await seed.destroy();
        }
      },
    });
    raw = createDb(h.dbUrl, 2);
    const db = kernelDb(raw);

    // both replicas are started: the reconciliation ran in one of them, the other found it done
    const made = await templateConnectors(db, orgId, "gmail");
    expect(made).toHaveLength(1);
    // the template needs an org credential nobody gave: it waits for an admin (needs_config), so
    // no tool listing is owed and nothing called its endpoint
    const owed = await db
      .selectFrom("outbox")
      .select("id")
      .where("queue", "=", CONNECTOR_TOOLS_QUEUE)
      .execute();
    expect(owed).toEqual([]);
    // recorded on the install, so an uninstall and upgrades see it
    const recorded = await db
      .selectFrom("plugin_install_components")
      .select(["ref", "template_id", "created"])
      .where("kind", "=", "connector")
      .execute();
    expect(recorded).toEqual([{ ref: made[0]?.id, template_id: "gmail", created: true }]);

    await restart(h, 1);
    expect(await templateConnectors(db, orgId, "gmail")).toHaveLength(1);
    // idempotent: run again (its done mark removed), it finds the connector and creates nothing
    await db
      .deleteFrom("deployment_settings")
      .where("key", "=", TEMPLATE_CONNECTOR_RECONCILE_SETTING)
      .execute();
    await restart(h, 2);
    expect(await templateConnectors(db, orgId, "gmail")).toHaveLength(1);
    expect(
      await db
        .selectFrom("deployment_settings")
        .select("key")
        .where("key", "=", TEMPLATE_CONNECTOR_RECONCILE_SETTING)
        .execute(),
    ).toHaveLength(1);

    // one-off: a connector deleted after the reconciliation is not made again by a restart
    await db
      .updateTable("connectors")
      .set({ deleted_at: new Date() })
      .where("id", "=", made[0]?.id as string)
      .execute();
    await restart(h, 0);
    expect(await templateConnectors(db, orgId, "gmail")).toHaveLength(0);
  });
});
