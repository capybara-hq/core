import { randomUUID } from "node:crypto";
import type { AgentTemplate, AgentTemplateTier } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb, SourceFormat } from "../db/kernel-schema.js";
import { canonicalJson } from "../tools/registry.js";

type Trx = Transaction<KernelDatabase>;

/**
 * Agent templates installed in an org from plugins (sub-agents spec §16): `agent_templates` (one
 * live row per org, plugin and name) and `agent_template_versions` (the parsed template). Plugin
 * install, upgrade and uninstall write them through the `…In` functions in the caller's
 * transaction; the roster and the effective definition read them through {@link loadTemplates}.
 * No in-process state.
 */

/** A live template of an org (`GET` listings, the agent page). */
export interface AgentTemplateView {
  id: string;
  name: string;
  plugin: string;
  /** The roster type `<plugin>:<name>`. */
  type: string;
  description: string;
  model: AgentTemplateTier;
  version: number;
  sourceFormat: SourceFormat;
  catalogItemId: string | null;
  catalogVersion: string | null;
}

/** A template row with its current definition. */
export interface TemplateRow {
  id: string;
  name: string;
  plugin: string;
  version: number;
  template: AgentTemplate;
  sourceFormat: SourceFormat;
  catalogItemId: string | null;
  catalogVersion: string | null;
}

const baseQuery = (db: KernelDb | Trx, orgId: string) =>
  db
    .selectFrom("agent_templates as t")
    .innerJoin("agent_template_versions as v", (j) =>
      j.onRef("v.template_id", "=", "t.id").onRef("v.version", "=", "t.current_version"),
    )
    .select([
      "t.id",
      "t.name",
      "t.plugin_name",
      "t.current_version",
      "t.catalog_item_id",
      "v.definition",
      "v.source_format",
      "v.catalog_version",
    ])
    .where("t.org_id", "=", orgId)
    .where("t.deleted_at", "is", null);

type RawRow = Awaited<ReturnType<ReturnType<typeof baseQuery>["execute"]>>[number];

const rowOf = (r: RawRow): TemplateRow => ({
  id: r.id,
  name: r.name,
  plugin: r.plugin_name,
  version: r.current_version,
  template: r.definition as AgentTemplate,
  sourceFormat: r.source_format,
  catalogItemId: r.catalog_item_id,
  catalogVersion: r.catalog_version,
});

/** The live templates of `ids` in the org (deleted and foreign ids are left out), by id. */
export async function loadTemplates(
  db: KernelDb | Trx,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, TemplateRow>> {
  if (ids.length === 0) return new Map();
  const rows = await baseQuery(db, orgId)
    .where("t.id", "in", [...ids])
    .execute();
  return new Map(rows.map((r) => [r.id, rowOf(r)]));
}

/** Reads the org's agent templates (consumed by the roster, the agent page and Task 19's API). */
export class AgentTemplatesService {
  constructor(private readonly db: KernelDb) {}

  /** Every live template of the org, by plugin then name. */
  async listForOrg(orgId: string): Promise<AgentTemplateView[]> {
    const rows = await baseQuery(this.db, orgId)
      .orderBy("t.plugin_name")
      .orderBy("t.name")
      .execute();
    return rows.map((r) => {
      const t = rowOf(r);
      return {
        id: t.id,
        name: t.name,
        plugin: t.plugin,
        type: `${t.plugin}:${t.name}`,
        description: typeof t.template.description === "string" ? t.template.description : "",
        model: t.template.model ?? "inherit",
        version: t.version,
        sourceFormat: t.sourceFormat,
        catalogItemId: t.catalogItemId,
        catalogVersion: t.catalogVersion,
      };
    });
  }

  /** A live template by id or by `<plugin>:<name>`; null when there is none. */
  async resolve(
    orgId: string,
    ref: string,
  ): Promise<{ id: string; version: number; plugin: string; template: AgentTemplate } | null> {
    const i = ref.indexOf(":");
    let q = baseQuery(this.db, orgId);
    q =
      i < 0
        ? q.where("t.id", "=", ref)
        : q.where("t.plugin_name", "=", ref.slice(0, i)).where("t.name", "=", ref.slice(i + 1));
    const r = await q.executeTakeFirst();
    if (!r) return null;
    const t = rowOf(r);
    return { id: t.id, version: t.version, plugin: t.plugin, template: t.template };
  }
}

/** Where a template version comes from (a plugin version of the catalog). */
export interface TemplateSource {
  orgId: string;
  plugin: string;
  catalogItemId: string;
  catalogVersion: string;
  sourceFormat: SourceFormat;
}

/**
 * Writes `template` as the org's live template `<plugin>:<name>` in the caller's transaction (the
 * caller holds the org row lock): a new template (version 1, `created`), a new version of the live
 * one when its definition differs (`changed`, the version added), or nothing when it is equal.
 */
export async function putTemplateVersionIn(
  t: Trx,
  s: TemplateSource,
  template: AgentTemplate,
): Promise<{ id: string; version: number; created: boolean; changed: boolean }> {
  const live = await t
    .selectFrom("agent_templates as a")
    .innerJoin("agent_template_versions as v", (j) =>
      j.onRef("v.template_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
    )
    .select(["a.id", "a.current_version", "v.definition"])
    .where("a.org_id", "=", s.orgId)
    .where("a.plugin_name", "=", s.plugin)
    .where("a.name", "=", template.name)
    .where("a.deleted_at", "is", null)
    .forUpdate("a")
    .executeTakeFirst();
  if (live && canonicalJson(live.definition) === canonicalJson(template)) {
    return { id: live.id, version: live.current_version, created: false, changed: false };
  }
  const id = live?.id ?? randomUUID();
  const version = live ? live.current_version + 1 : 1;
  if (!live) {
    await t
      .insertInto("agent_templates")
      .values({
        id,
        org_id: s.orgId,
        name: template.name,
        catalog_item_id: s.catalogItemId,
        plugin_name: s.plugin,
        current_version: 1,
      })
      .execute();
  }
  await t
    .insertInto("agent_template_versions")
    .values({
      template_id: id,
      version,
      definition: JSON.stringify(template),
      source_format: s.sourceFormat,
      catalog_version: s.catalogVersion,
    })
    .execute();
  if (live) {
    await t
      .updateTable("agent_templates")
      .set({ current_version: version, catalog_item_id: s.catalogItemId, updated_at: new Date() })
      .where("id", "=", id)
      .execute();
  }
  return { id, version, created: !live, changed: true };
}

/**
 * Undoes `version` of a live template when it is still the current one (an install or upgrade
 * rolled back): the version row goes and the template is back at the version before. Returns
 * whether anything changed.
 */
export async function revertTemplateVersionIn(
  t: Trx,
  orgId: string,
  id: string,
  version: number,
): Promise<boolean> {
  if (version <= 1) return false;
  const r = await t
    .updateTable("agent_templates")
    .set({ current_version: version - 1, updated_at: new Date() })
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .where("current_version", "=", version)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (r.numUpdatedRows === 0n) return false;
  await t
    .deleteFrom("agent_template_versions")
    .where("template_id", "=", id)
    .where("version", "=", version)
    .execute();
  return true;
}

/**
 * Removes a template (soft delete: sub-agents already started keep their frozen definition, and
 * the roster skips it). Returns whether it was live.
 */
export async function softDeleteTemplateIn(t: Trx, orgId: string, id: string): Promise<boolean> {
  const r = await t
    .updateTable("agent_templates")
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}
