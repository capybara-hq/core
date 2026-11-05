import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PluginInstaller } from "../../src/catalog/plugin-install.js";
import { ScopeNoLongerWanted } from "../../src/catalog/scope-state.js";
import { PLUGIN_SCOPE_QUEUE, PluginScopeSync } from "../../src/catalog/scope-sync.js";
import { createOrg, waitFor } from "../helpers/runs.js";
import { type OrgEnv, resetOrgCatalog, seedPlugin, setScope, startOrgEnv } from "./org-env.js";

/**
 * The plugin scope sync (spec §5): a worker job converges every org to the item's scope by
 * installing (as the system: audit actor null, `via: "scope"`, no switch row) or uninstalling.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

const sync = () => env.k.app.get(PluginScopeSync);
const queue = () => env.k.app.get<Queue>(getQueueToken(PLUGIN_SCOPE_QUEUE));

/** Waits until the scope queue has nothing waiting, delayed or running. */
async function idle(): Promise<void> {
  await waitFor(
    async () => {
      const c = await queue().getJobCounts("waiting", "active", "delayed", "prioritized");
      return Object.values(c).every((n) => n === 0);
    },
    30_000,
    "scope queue idle",
  );
}

/** The live installs of an item, as the orgs they are in. */
async function liveOrgs(itemId: string): Promise<string[]> {
  const rows = await env.db
    .selectFrom("plugin_installs")
    .select("org_id")
    .where("item_id", "=", itemId)
    .where("status", "in", ["installing", "installed", "upgrading"])
    .execute();
  return rows.map((r) => r.org_id).sort();
}

async function auditRows(action: string) {
  return env.db
    .selectFrom("audit_events")
    .select(["actor_account_id", "org_id", "target", "detail"])
    .where("action", "=", action)
    .orderBy("id")
    .execute();
}

/** Bumps the item's scope version (what the admin API does with every scope change). */
async function bump(itemId: string): Promise<void> {
  const row = await env.db
    .selectFrom("catalog_items")
    .select("scope_version")
    .where("id", "=", itemId)
    .executeTakeFirstOrThrow();
  await env.db
    .updateTable("catalog_items")
    .set({ scope_version: row.scope_version + 1 })
    .where("id", "=", itemId)
    .execute();
}

const skillsOnly = (name: string, deps?: { name: string; version: string }[]) =>
  seedPlugin(env, {
    name,
    skills: [`${name}-skill`],
    templates: false,
    ...(deps !== undefined && { dependencies: deps }),
  });

async function switchRow(itemId: string, orgId: string, enabled: boolean): Promise<void> {
  await env.db
    .insertInto("catalog_item_org_switches")
    .values({ item_id: itemId, org_id: orgId, enabled })
    .execute();
}

describe("plugin scope sync", { timeout: 90_000 }, () => {
  it("all: every org gets a live install, and so does an org created afterwards", async () => {
    const itemId = await skillsOnly("everywhere");
    const orgB = await createOrg(env.root, "Scope B");
    await setScope(env, itemId, "all");
    await bump(itemId);
    await sync().enqueueItem(itemId);
    await idle();
    const orgs = await env.db
      .selectFrom("orgs")
      .select("id")
      .where("deleted_at", "is", null)
      .execute();
    expect(await liveOrgs(itemId)).toEqual(orgs.map((o) => o.id).sort());
    expect(await liveOrgs(itemId)).toContain(orgB);
    // installed by the system: no actor, via scope, and no switch row (nobody chose it)
    const installed = await auditRows("plugin.org_installed");
    expect(installed.length).toBe(orgs.length);
    for (const r of installed) {
      expect(r.actor_account_id).toBeNull();
      expect(r.detail).toMatchObject({ itemId, via: "scope" });
    }
    expect(await env.db.selectFrom("catalog_item_org_switches").selectAll().execute()).toHaveLength(
      0,
    );
    const orgC = await createOrg(env.root, "Scope C");
    await waitFor(
      async () => (await liveOrgs(itemId)).includes(orgC),
      30_000,
      "install in the new org",
    );
  });

  it("named [A, B] with B switched off: A installed, B and C not", async () => {
    const a = await createOrg(env.root, "Named A");
    const b = await createOrg(env.root, "Named B");
    const c = await createOrg(env.root, "Named C");
    const itemId = await skillsOnly("listed");
    await setScope(env, itemId, "named", [a, b]);
    await switchRow(itemId, b, false);
    await bump(itemId);
    await sync().enqueueItem(itemId);
    await idle();
    expect(await liveOrgs(itemId)).toEqual([a]);
    expect(await sync().syncPair(itemId, b)).toBe("unchanged");
    expect(await sync().syncPair(itemId, c)).toBe("unchanged");
  });

  it("a plugin with connector templates set to all is needs_config: no install, no failure", async () => {
    const itemId = await seedPlugin(env, { name: "tpl", skills: ["tpl-skill"] });
    await setScope(env, itemId, "all");
    await bump(itemId);
    await sync().enqueueItem(itemId);
    await idle();
    expect(await liveOrgs(itemId)).toEqual([]);
    expect(await sync().syncPair(itemId, env.orgId)).toBe("needs_config");
    expect(await auditRows("plugin.scope_sync_failed")).toEqual([]);
    expect(await auditRows("plugin.org_install_failed")).toEqual([]);
  });

  it("all -> optional without switch rows removes the installs", async () => {
    const itemId = await skillsOnly("shrinking");
    await setScope(env, itemId, "all");
    await bump(itemId);
    await sync().enqueueItem(itemId);
    await idle();
    expect((await liveOrgs(itemId)).length).toBeGreaterThan(0);
    await setScope(env, itemId, "optional");
    await bump(itemId);
    await sync().enqueueItem(itemId);
    await idle();
    expect(await auditRows("plugin.scope_sync_failed")).toEqual([]);
    expect(await liveOrgs(itemId)).toEqual([]);
    const removed = await auditRows("plugin.org_uninstalled");
    expect(removed.length).toBeGreaterThan(0);
    for (const r of removed) expect(r.actor_account_id).toBeNull();
    // nobody chose it: no switch row written by the uninstall either
    expect(await env.db.selectFrom("catalog_item_org_switches").selectAll().execute()).toHaveLength(
      0,
    );
  });

  it("a dependency stays installed where its dependent is on, whatever its own scope", async () => {
    const x = await createOrg(env.root, "Dep X");
    const y = await createOrg(env.root, "Dep Y");
    const depId = await skillsOnly("dep-b");
    const appId = await skillsOnly("app-a", [{ name: "dep-b", version: "^1.0.0" }]);
    await setScope(env, appId, "optional");
    await switchRow(appId, x, true);
    await setScope(env, depId, "named", [y]);
    await bump(appId);
    await bump(depId);
    await sync().enqueueItem(appId);
    await sync().enqueueItem(depId);
    await idle();
    expect(await liveOrgs(appId)).toEqual([x]);
    expect(await liveOrgs(depId)).toEqual([x, y].sort());
    // B in X is A's dependency: wanted on there, the sync leaves it
    expect(await sync().syncPair(depId, x)).toBe("unchanged");
    await sync().enqueueItem(depId);
    await idle();
    expect(await liveOrgs(depId)).toEqual([x, y].sort());
    expect(await auditRows("plugin.scope_sync_failed")).toEqual([]);
  });

  it("a created dependency its own scope wants on survives the dependent's switch-off, untouched", async () => {
    const depId = await skillsOnly("dep-kept");
    const appId = await skillsOnly("app-off", [{ name: "dep-kept", version: "^1.0.0" }]);
    await setScope(env, appId, "optional");
    // a person switches A on (B comes along as A's dependency, created by A's install)
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${appId}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const depInstall = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", depId)
      .where("org_id", "=", env.orgId)
      .executeTakeFirstOrThrow();
    // B's own scope becomes all
    await setScope(env, depId, "all");
    // the person switches A off: preview, then confirm
    const url = `/api/v1/orgs/${env.orgId}/catalog/${appId}/switch`;
    const pre = await env.boss({ method: "PUT", url, payload: { enabled: false } });
    expect(pre.statusCode, pre.body).toBe(200);
    const body = pre.json() as {
      preview: { kept: { kind: string; ref: string; reason: string }[] };
      confirm: string;
    };
    expect(body.preview.kept).toContainEqual({
      kind: "plugin",
      ref: depInstall.id,
      reason: "wanted_by_scope",
    });
    const off = await env.boss({
      method: "PUT",
      url,
      payload: { enabled: false, confirm: body.confirm },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await liveOrgs(appId)).not.toContain(env.orgId);
    // B is the same install, standalone, and its skill was not deleted
    const after = await env.db
      .selectFrom("plugin_installs")
      .select(["id", "status"])
      .where("item_id", "=", depId)
      .where("org_id", "=", env.orgId)
      .execute();
    expect(after).toEqual([{ id: depInstall.id, status: "installed" }]);
    const skill = await env.db
      .selectFrom("skills")
      .select("deleted_at")
      .where("org_id", "=", env.orgId)
      .where("name", "=", "dep-kept-skill")
      .executeTakeFirstOrThrow();
    expect(skill.deleted_at).toBeNull();
    // the sync leaves it as it is (no reinstall)
    expect(await sync().syncPair(depId, env.orgId)).toBe("unchanged");
    const still = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", depId)
      .where("org_id", "=", env.orgId)
      .execute();
    expect(still).toEqual([{ id: depInstall.id }]);
  });

  it("a scope install after the person switched the plugin off is refused under the org lock", async () => {
    const itemId = await skillsOnly("raced");
    await setScope(env, itemId, "named", [env.orgId]);
    // the sync decided "wanted on"; the person's switch-off commits before the install row
    await switchRow(itemId, env.orgId, false);
    await expect(
      env.k.app
        .get(PluginInstaller)
        .install(env.orgId, null, itemId, "1.0.0", {}, { via: "scope" }),
    ).rejects.toBeInstanceOf(ScopeNoLongerWanted);
    expect(await liveOrgs(itemId)).toEqual([]);
    const rows = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", itemId)
      .execute();
    expect(rows).toEqual([]);
    expect(await auditRows("plugin.org_install_failed")).toEqual([]);
    expect(await auditRows("plugin.scope_sync_failed")).toEqual([]);
  });
});
