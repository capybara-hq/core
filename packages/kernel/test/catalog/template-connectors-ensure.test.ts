import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginInstaller } from "../../src/catalog/plugin-install.js";
import { TemplateConnectorEnsurer } from "../../src/catalog/template-connector-ensure.js";
import { TEMPLATE_CONNECTORS_QUEUE } from "../../src/catalog/template-connector-jobs.js";
import {
  TEMPLATE_CONNECTOR_RECONCILE_SETTING,
  TemplateConnectorReconciler,
} from "../../src/catalog/template-connector-reconcile.js";
import { BOOTSTRAP_LOCK_KEY } from "../../src/extensions/bootstrap.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { drainOutbox } from "../helpers/outbox.js";
import { waitFor } from "../helpers/runs.js";
import {
  install,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
  syncItemNow,
} from "./org-env.js";

/**
 * Ruling R27: the template connectors an org never had are created by one routine
 * (`TemplateConnectorEnsurer`), called by the queued ensure an install's commit or an extension
 * switch-on owes, by the scope sync after it added dependencies, and by the one-off startup
 * reconciliation (rulings R23–R26: its mark, the skipped refusals, the lock it never waits for).
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  // an earlier test's queued ensures run before the reset, never into this test
  await drainOutbox(env.k.app, { queue: TEMPLATE_CONNECTORS_QUEUE });
  const queue = env.k.app.get<Queue>(getQueueToken(TEMPLATE_CONNECTORS_QUEUE));
  await waitFor(
    async () =>
      Object.values(await queue.getJobCounts("waiting", "active", "delayed", "prioritized")).every(
        (n) => n === 0,
      ),
    30_000,
    "idle template connector ensures",
  );
  await resetOrgCatalog(env);
});

const ensurer = () => env.k.app.get(TemplateConnectorEnsurer);
const reconciler = () => env.k.app.get(TemplateConnectorReconciler);

/** The org's connectors made from the item's template `templateId` (`deleted`: also deleted ones). */
async function templateConnectors(
  itemId: string,
  templateId = "gh",
  deleted = false,
): Promise<string[]> {
  let q = env.db
    .selectFrom("connectors as c")
    .innerJoin("platform_connector_templates as p", "p.id", "c.platform_template_id")
    .select("c.id")
    .where("c.org_id", "=", env.orgId)
    .where("p.catalog_item_id", "=", itemId)
    .where("p.template_id", "=", templateId);
  if (!deleted) q = q.where("c.deleted_at", "is", null);
  return (await q.execute()).map((r) => r.id);
}

/** An install of the item in the org written directly (the state an earlier install left). */
async function seedInstalled(itemId: string): Promise<void> {
  await env.db
    .insertInto("plugin_installs")
    .values({
      id: randomUUID(),
      org_id: env.orgId,
      item_id: itemId,
      version: "1.0.0",
      status: "installed",
      installed_by: null,
    })
    .execute();
}

/** Switches the template connector extension off in the org (its kind is then unavailable). */
async function connectorExtensionOff(): Promise<void> {
  await env.db
    .deleteFrom("extension_org_configs")
    .where("org_id", "=", env.orgId)
    .where("plugin", "=", "fake-connector")
    .execute();
}

const mark = () =>
  env.db
    .selectFrom("deployment_settings")
    .select("key")
    .where("key", "=", TEMPLATE_CONNECTOR_RECONCILE_SETTING)
    .execute();

describe("ensureTemplateConnectorsIn", () => {
  it("never makes again a template connector an admin deleted", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: [] });
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const [id] = await templateConnectors(itemId);
    expect(id).toBeDefined();
    await env.db
      .updateTable("connectors")
      .set({ deleted_at: new Date() })
      .where("id", "=", id as string)
      .execute();

    expect(await ensurer().ensureTemplateConnectorsIn(env.orgId)).toEqual({
      created: 0,
      skipped: 0,
      notLoaded: 0,
    });
    expect(await templateConnectors(itemId)).toEqual([]);
  });

  it("creates the connector of a plugin installed before its connector extension was on, once the extension is switched on (the queued ensure)", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: [] });
    await connectorExtensionOff();
    await seedInstalled(itemId);
    expect(await templateConnectors(itemId)).toEqual([]);

    const r = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/extensions/fake-connector`,
      payload: { enabled: true },
    });
    expect(r.statusCode, r.body).toBe(200);
    await drainOutbox(env.k.app, { queue: TEMPLATE_CONNECTORS_QUEUE });
    await waitFor(
      async () => (await templateConnectors(itemId)).length === 1,
      10_000,
      "the template connector from the queued ensure",
    );
    // recorded on the install, created by the plugin
    const recorded = await env.db
      .selectFrom("plugin_install_components")
      .select(["template_id", "created"])
      .where("kind", "=", "connector")
      .execute();
    expect(recorded).toEqual([{ template_id: "gh", created: true }]);
  });

  it("creates the dependent plugin's connector when the scope sync installs the dependency that provides its kind", async () => {
    // the dependency's own extension is the template's connector extension
    await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
    });
    const itemId = await seedPlugin(env, {
      name: "crm",
      skills: [],
      dependencies: [{ name: "fake-connector", version: "^1.0.0" }],
    });
    await connectorExtensionOff();
    await seedInstalled(itemId);
    await setScope(env, itemId, "all");

    await syncItemNow(env, itemId);
    // the sync installed the dependency and, right after, created the connector it now allows
    expect(await templateConnectors(itemId)).toHaveLength(1);
  });

  it("skips a template switched off in the org and one shipped default-off", async () => {
    const itemId = await seedPlugin(env, {
      name: "crm",
      skills: [],
      templates: { gh: {}, jira: {}, wiki: {} },
      defaultOff: ["wiki"],
    });
    await seedInstalled(itemId);
    const jira = await env.db
      .selectFrom("platform_connector_templates")
      .select("id")
      .where("template_id", "=", "jira")
      .executeTakeFirstOrThrow();
    await env.db
      .insertInto("component_org_switches")
      .values({
        kind: "connector_template",
        component_id: jira.id,
        org_id: env.orgId,
        enabled: false,
      })
      .execute();

    expect(await ensurer().ensureTemplateConnectorsIn(env.orgId)).toMatchObject({ created: 1 });
    expect(await templateConnectors(itemId, "gh")).toHaveLength(1);
    expect(await templateConnectors(itemId, "jira")).toEqual([]);
    expect(await templateConnectors(itemId, "wiki")).toEqual([]);
  });
});

describe("the startup reconciliation", () => {
  it("skips a refused template (its kind off in the org) and still writes its mark", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: [] });
    await connectorExtensionOff();
    await seedInstalled(itemId);

    expect(await reconciler().run()).toEqual({ created: 0 });
    expect(await mark()).toHaveLength(1);
    expect(await templateConnectors(itemId)).toEqual([]);
  });

  it("an unexpected error stops the pass without its mark", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: [] });
    await seedInstalled(itemId);
    const spy = vi
      .spyOn(env.k.app.get(PluginInstaller), "createSwitchedOnTemplateConnectorIn")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    try {
      await expect(reconciler().run()).rejects.toThrow("Connection terminated unexpectedly");
    } finally {
      spy.mockRestore();
    }
    expect(await mark()).toEqual([]);
    // the next start resumes it
    expect(await reconciler().run()).toEqual({ created: 1 });
    expect(await mark()).toHaveLength(1);
  });

  it("a replica that does not get lock:bootstrap skips the pass", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: [] });
    await seedInstalled(itemId);
    const held = await env.k.app.get(LockService).acquire(BOOTSTRAP_LOCK_KEY, { ttlMs: 30_000 });
    expect(held).toBeDefined();
    try {
      expect(await reconciler().run()).toEqual({ created: 0 });
    } finally {
      await held?.release();
    }
    expect(await mark()).toEqual([]);
    expect(await templateConnectors(itemId)).toEqual([]);
  });
});
