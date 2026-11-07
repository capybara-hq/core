// Turning 可共享 off on an org-owned item (ruling P3-25): an `optional` / `all` scope is narrowed, in
// the caller's transaction, to `named` = the owner plus every live org where the item is on right
// now, so the orgs already associated keep it and no new org can see, switch on or request it
// (§14.1 item 3). A `named` scope is left as it is: the gate in `requestable` and the writers
// already holds back new orgs there.
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import {
  type ComponentRow,
  componentOn,
  listedIn,
  loadScopeState,
  pluginFactsOf,
  switchOf,
} from "./component-state.js";
import type { PluginScope } from "./scope.js";

const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

async function liveOrgIds(db: KernelSchemaDb): Promise<string[]> {
  const rows = await db.selectFrom("orgs").select("id").where("deleted_at", "is", null).execute();
  return rows.map((r) => r.id);
}

/**
 * Narrows an org-owned plugin (row locked by the caller) whose scope is `optional` / `all` to
 * `named` = owner + the live orgs with a live install or a switch on. Bumps `scope_version` and
 * audits `catalog.scope_changed`; returns whether the scope changed (the caller enqueues the item's
 * scope sync after the commit).
 */
export async function narrowItemOnUnshare(
  db: KernelSchemaDb,
  actor: string | null,
  item: { id: string; name: string; scope: PluginScope; owner_org_id: string | null },
): Promise<boolean> {
  if (item.owner_org_id === null || item.scope === "named") return false;
  const live = new Set(await liveOrgIds(db));
  const installs = await db
    .selectFrom("plugin_installs")
    .select("org_id")
    .where("item_id", "=", item.id)
    .where("status", "in", [...LIVE_INSTALL])
    .execute();
  const switches = await db
    .selectFrom("catalog_item_org_switches")
    .select("org_id")
    .where("item_id", "=", item.id)
    .where("enabled", "=", true)
    .execute();
  const orgs = [
    ...new Set([
      item.owner_org_id,
      ...[...installs, ...switches].map((r) => r.org_id).filter((o) => live.has(o)),
    ]),
  ].sort();
  await db
    .updateTable("catalog_items")
    .set({
      scope: "named",
      scope_version: sql<number>`scope_version + 1`,
      updated_at: sql<Date>`now()` as unknown as Date,
    })
    .where("id", "=", item.id)
    .execute();
  await db.deleteFrom("catalog_item_scope_orgs").where("item_id", "=", item.id).execute();
  await db
    .insertInto("catalog_item_scope_orgs")
    .values(orgs.map((org_id) => ({ item_id: item.id, org_id })))
    .execute();
  await audit(db, {
    ...(actor !== null && { actorAccountId: actor }),
    action: "catalog.scope_changed",
    target: item.id,
    detail: {
      name: item.name,
      from: { scope: item.scope, orgs: [] },
      to: { scope: "named", orgs },
      reason: "unshared",
    },
  });
  return true;
}

/**
 * Narrows an org-owned component with its own `optional` / `all` scope (row locked by the caller)
 * to `named` = owner + the live orgs where it is on now ({@link componentOn}). A component that
 * follows its plugin is narrowed with the plugin. Bumps `scope_version`, audits
 * `component.scope_changed`.
 */
export async function narrowComponentOnUnshare(
  db: KernelSchemaDb,
  actor: string | null,
  c: ComponentRow,
): Promise<boolean> {
  if (c.ownerOrgId === null || c.scopeMode !== "own" || c.scope === "named") return false;
  const st = await loadScopeState(db, c.kind, [c]);
  const on = (await liveOrgIds(db)).filter((o) =>
    componentOn(c, pluginFactsOf(st, c.itemId, o), listedIn(st, c.id, o), switchOf(st, c.id, o)),
  );
  const orgs = [...new Set([c.ownerOrgId, ...on])].sort();
  await db
    .updateTable(TABLE[c.kind] as "platform_skills")
    .set({
      scope: "named",
      scope_version: sql<number>`scope_version + 1`,
      updated_at: sql<Date>`now()` as unknown as Date,
    })
    .where("id", "=", c.id)
    .execute();
  await db
    .deleteFrom("component_scope_orgs")
    .where("kind", "=", c.kind)
    .where("component_id", "=", c.id)
    .execute();
  await db
    .insertInto("component_scope_orgs")
    .values(orgs.map((org_id) => ({ kind: c.kind, component_id: c.id, org_id })))
    .execute();
  await audit(db, {
    ...(actor !== null && { actorAccountId: actor }),
    action: "component.scope_changed",
    target: c.id,
    detail: {
      kind: c.kind,
      name: c.name,
      plugin: c.plugin,
      from: { scopeMode: "own", scope: c.scope, orgs: [] },
      to: { scopeMode: "own", scope: "named", orgs },
      reason: "unshared",
    },
  });
  return true;
}

const TABLE = {
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
  connector_template: "platform_connector_templates",
} as const;
