import { randomUUID } from "node:crypto";
import type { AgentTemplate, AgentTemplateTier, Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { componentOn } from "../catalog/component-state.js";
import type { KernelSchemaDb, SourceFormat } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { loadLegacyScope } from "../tools/legacy-data.js";
import type { LegacyScope } from "../tools/legacy-keys.js";
import { needsLegacyScope, normalizeToolKeys } from "./definition.js";

/**
 * Agent templates of an org (sub-agents spec §16): its own `agent_templates` (one live row per org,
 * plugin and name) with `agent_template_versions` (the parsed template), and the platform templates
 * (plugin scope phase 2, rulings A2, C2: `platform_agent_templates`) that are on in the org. Plugin
 * install, upgrade and uninstall write the org rows through the `…In` functions in the caller's
 * transaction; the roster and the effective definition read both through {@link loadTemplates}.
 * An org copy linked to a platform template (ruling B2) resolves to the platform template's current
 * version under the copy's own id unless pinned. A copy linked to a platform template its own org
 * owns (promote on share, ruling P3-3) serves its own stored version while that is the platform
 * template's current one, and is listed instead of it. No in-process state.
 */

/** A usable template of an org (`GET` listings, the agent page). */
export interface AgentTemplateView {
  id: string;
  name: string;
  plugin: string | null;
  /** The roster type: `<plugin>:<name>`, or the bare `<name>` without a plugin. */
  type: string;
  description: string;
  model: AgentTemplateTier;
  version: number;
  sourceFormat: SourceFormat;
  catalogItemId: string | null;
  catalogVersion: string | null;
  /** `org`: the org's own template; `platform`: a platform template on in the org. */
  origin: "org" | "platform";
  /**
   * Platform templates: this org's unpinned copies linked to it (ruling B2). They resolve to this
   * template under their own ids, so an agent that selects one of them selects this template.
   */
  linkedIds?: string[];
}

/** A template with its current definition (an org row, a linked copy or a platform template). */
export interface TemplateRow {
  /** The org template's id (a linked copy keeps its own), or the platform template's. */
  id: string;
  name: string;
  plugin: string | null;
  version: number;
  template: AgentTemplate;
  sourceFormat: SourceFormat;
  catalogItemId: string | null;
  catalogVersion: string | null;
  /** `platform` for a platform template and for a linked copy that resolves to one. */
  origin: "org" | "platform";
  /**
   * The platform template whose content this is (a platform template, or an unpinned linked
   * copy); absent for the org's own content (a pinned copy included). `subagent_started` records
   * it, so evals tell the two version namespaces apart.
   */
  platformTemplateId?: string;
  /**
   * The org's own template it promoted (ruling P3-3), served from its platform template: listed
   * as the org's own. Never recorded in an event.
   */
  ownedCopy?: true;
}

/** The roster type of a template: `<plugin>:<name>`, the bare `<name>` without a plugin. */
export const templateTypeOf = (plugin: string | null, name: string): string =>
  plugin ? `${plugin}:${name}` : name;

/** Plugin install statuses that make a plugin on in the org (phase 1, org catalog state). */
const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

const baseQuery = (db: KernelSchemaDb, orgId: string) =>
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
      "t.platform_template_id",
      "t.pinned_version",
      "v.definition",
      "v.source_format",
      "v.catalog_version",
    ])
    .where("t.org_id", "=", orgId)
    .where("t.deleted_at", "is", null);

/** An org row or a platform row before its tool keys are normalized. */
interface RawRow {
  id: string;
  name: string;
  plugin: string | null;
  version: number;
  definition: unknown;
  sourceFormat: SourceFormat;
  catalogItemId: string | null;
  catalogVersion: string | null;
  origin: "org" | "platform";
  platformTemplateId?: string;
  ownedCopy?: true;
}

/**
 * The ids among `platformIds` of the live platform templates owned by `orgId` (promoted from its
 * own templates, ruling P3-3).
 */
async function ownedPlatformIds(
  db: KernelSchemaDb,
  orgId: string,
  platformIds: readonly string[],
): Promise<Set<string>> {
  if (platformIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("platform_agent_templates")
    .select("id")
    .where("id", "in", [...new Set(platformIds)])
    .where("owner_org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .execute();
  return new Set(rows.map((r) => r.id));
}

/**
 * Stored rows as {@link TemplateRow}s; tool keys read as current keys (tool naming spec §8.3): old
 * builtin names always, rc `<x>__<tool>` keys with the org's legacy scope, read once when needed.
 */
async function normalized(
  db: KernelSchemaDb,
  orgId: string,
  rows: readonly RawRow[],
): Promise<TemplateRow[]> {
  const scope: LegacyScope | undefined = rows.some((r) => needsLegacyScope(r.definition))
    ? await loadLegacyScope(db, orgId)
    : undefined;
  return rows.map(({ definition, ...r }) => ({
    ...r,
    template: normalizeToolKeys(definition, scope) as AgentTemplate,
  }));
}

const orgRaw = (r: Awaited<ReturnType<ReturnType<typeof baseQuery>["execute"]>>[number]) =>
  ({
    id: r.id,
    name: r.name,
    plugin: r.plugin_name,
    version: r.current_version,
    definition: r.definition,
    sourceFormat: r.source_format,
    catalogItemId: r.catalog_item_id,
    catalogVersion: r.catalog_version,
    // a pinned copy keeps its link but serves its own version: no platform content source
    origin: "org",
  }) satisfies RawRow;

/** The live platform template rows on in the org (`ids`: only those), before any type clash. */
async function platformRowsOn(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[] | undefined,
) {
  if (ids !== undefined && ids.length === 0) return [];
  let q = db
    .selectFrom("platform_agent_templates as p")
    .innerJoin("platform_agent_template_versions as v", (j) =>
      j.onRef("v.template_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
    )
    .leftJoin("catalog_items as c", (j) =>
      j.onRef("c.id", "=", "p.catalog_item_id").on("c.deleted_at", "is", null),
    )
    .select((eb) => [
      "p.id",
      "p.name",
      "p.plugin_name",
      "p.catalog_item_id",
      "p.current_version",
      "p.scope_mode",
      "p.scope",
      "v.definition",
      "v.source_format",
      "v.catalog_version",
      "c.id as item_id",
      "c.disabled as item_disabled",
      "c.builtin as item_builtin",
      eb
        .exists(
          eb
            .selectFrom("plugin_installs as a")
            .select("a.id")
            .whereRef("a.item_id", "=", "p.catalog_item_id")
            .where("a.org_id", "=", orgId)
            .where("a.status", "in", [...LIVE_INSTALL]),
        )
        .as("installed"),
      eb
        .exists(
          eb
            .selectFrom("component_scope_orgs as l")
            .select("l.org_id")
            .where("l.kind", "=", "agent_template")
            .whereRef("l.component_id", "=", "p.id")
            .where("l.org_id", "=", orgId),
        )
        .as("listed"),
      eb
        .selectFrom("component_org_switches as w")
        .select("w.enabled")
        .where("w.kind", "=", "agent_template")
        .whereRef("w.component_id", "=", "p.id")
        .where("w.org_id", "=", orgId)
        .as("switch"),
    ])
    .where("p.deleted_at", "is", null)
    .where("p.disabled", "=", false);
  if (ids !== undefined) q = q.where("p.id", "in", [...ids]);
  // the predicate of component scope (catalog/component-state.ts); `disabled` is filtered above
  return (await q.execute()).filter((r) =>
    componentOn(
      { scopeMode: r.scope_mode, scope: r.scope, disabled: false, itemId: r.catalog_item_id },
      r.catalog_item_id === null
        ? null
        : {
            live: r.item_id !== null,
            disabled: r.item_disabled === true,
            builtin: r.item_builtin === true,
            // the plugin's own scope and list do not decide whether a component is on
            scope: "optional",
            listed: false,
            installed: Boolean(r.installed),
          },
      Boolean(r.listed),
      r.switch ?? null,
    ),
  );
}

/**
 * The ids among `ids` of the platform templates on in the org (see {@link platformOn}), whatever
 * the org's own templates are.
 */
export async function platformTemplatesOn(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  return new Set((await platformRowsOn(db, orgId, ids)).map((r) => r.id));
}

/**
 * Rule 10 for platform agent template `component` (`plugin` / `name`: its roster type) newly
 * offered to the org (ruling P4-13, as `skillNameClashes` for skills): the org's own live rows of
 * that type (unlinked, or pinned) that are no copy of it (linked to it, or from its plugin), and
 * the other platform templates of that type on in the org (two orgs' shared templates of one bare
 * name, P3-5). `skills`: the clashing template ids; `plugins`: the clashing platform templates'
 * plugins (`platform` for none).
 */
export async function templateTypeClashes(
  db: KernelSchemaDb,
  orgId: string,
  component: { id: string; itemId: string | null; plugin: string | null; name: string },
): Promise<{ skills: string[]; plugins: string[] }> {
  const own = await db
    .selectFrom("agent_templates")
    .select(["id", "platform_template_id", "catalog_item_id"])
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .where("name", "=", component.name)
    .where((eb) =>
      component.plugin === null
        ? eb("plugin_name", "is", null)
        : eb("plugin_name", "=", component.plugin),
    )
    .where((eb) =>
      eb.or([eb("platform_template_id", "is", null), eb("pinned_version", "is not", null)]),
    )
    .execute();
  const ownIds = own
    .filter(
      (r) =>
        r.platform_template_id !== component.id &&
        (component.itemId === null || r.catalog_item_id !== component.itemId),
    )
    .map((r) => r.id);
  const others = await db
    .selectFrom("platform_agent_templates")
    .select(["id", "plugin_name"])
    .where("name", "=", component.name)
    .where((eb) =>
      component.plugin === null
        ? eb("plugin_name", "is", null)
        : eb("plugin_name", "=", component.plugin),
    )
    .where("deleted_at", "is", null)
    .where("id", "!=", component.id)
    .execute();
  const on = await platformTemplatesOn(
    db,
    orgId,
    others.map((o) => o.id),
  );
  const platform = others.filter((o) => on.has(o.id));
  return {
    skills: [...ownIds, ...platform.map((o) => o.id)],
    plugins: platform.map((o) => o.plugin_name ?? "platform"),
  };
}

/**
 * The ids among `ids` (platform templates that org copies are pinned to) whose pinned copies the
 * org may use (ruling P2-18): the platform template is on in the org, or it was removed by a
 * plugin update (soft-deleted, ruling P2-7: a pinned copy then keeps its own version as the org's).
 */
async function pinnedTemplateLinksServed(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const removed = await db
    .selectFrom("platform_agent_templates")
    .select("id")
    .where("id", "in", [...ids])
    .where("deleted_at", "is not", null)
    .execute();
  return new Set([...(await platformTemplatesOn(db, orgId, ids)), ...removed.map((r) => r.id)]);
}

/**
 * The platform templates on in the org (`ids`: only those), minus the ones whose type an org
 * template of its own (unlinked, or pinned) already has (the org's wins; logged unless it is a copy
 * of the same component: linked to it, or from the same catalog item; `shadowed` maps such a
 * platform id to that org row's id). On in the org:
 * - never when the template or its plugin is disabled (or its plugin is deleted);
 * - `follow`: its plugin is on in the org (a live install, or builtin) and no component switch of
 *   the org says off;
 * - `own`: `wantedOn` over the template's own scope, the org's list membership and its switch.
 * One query for the templates with their plugin and org state, one for the org's clashing rows.
 */
async function platformOn(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[] | undefined,
  log?: Pick<Logger, "warn">,
): Promise<{ rows: RawRow[]; shadowed: Map<string, string> }> {
  const shadowed = new Map<string, string>();
  const rows = await platformRowsOn(db, orgId, ids);
  if (rows.length === 0) return { rows: [], shadowed };
  const own = await db
    .selectFrom("agent_templates")
    .select(["id", "name", "plugin_name", "platform_template_id", "catalog_item_id"])
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([eb("platform_template_id", "is", null), eb("pinned_version", "is not", null)]),
    )
    .where("name", "in", [...new Set(rows.map((r) => r.name))])
    .execute();
  const ownByType = new Map(own.map((r) => [templateTypeOf(r.plugin_name, r.name), r]));
  const out: RawRow[] = [];
  for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const o = ownByType.get(templateTypeOf(r.plugin_name, r.name));
    if (o) {
      const sameComponent =
        o.platform_template_id === r.id ||
        (o.catalog_item_id !== null && o.catalog_item_id === r.catalog_item_id);
      if (!sameComponent) {
        log?.warn("platform agent template shadowed by an org template of the same type", {
          orgId,
          type: templateTypeOf(r.plugin_name, r.name),
          platformTemplateId: r.id,
          templateId: o.id,
        });
      } else {
        shadowed.set(r.id, o.id);
      }
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      plugin: r.plugin_name,
      version: r.current_version,
      definition: r.definition,
      sourceFormat: r.source_format,
      catalogItemId: r.catalog_item_id,
      catalogVersion: r.catalog_version,
      origin: "platform",
      platformTemplateId: r.id,
    });
  }
  return { rows: out, shadowed };
}

/**
 * The org's live templates by id (`ids`; ids that are no usable template are missing): an org
 * template with its current version; an org copy linked to a platform template without a pin
 * (ruling B2) as that platform template's current version under the copy's id, while the platform
 * template is on in the org; a pinned copy as its own version while its platform template is on in
 * the org (ruling P2-18); a platform template id while it is on in the org, or, when an org row
 * of the same component (unlinked or pinned) wins its type, as that row (its `id` is the row's: the
 * roster lists the platform id as an alias). Deleted and foreign ids are left out. `log` receives
 * the type-clash warnings.
 */
export async function loadTemplates(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
  log?: Pick<Logger, "warn">,
): Promise<Map<string, TemplateRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await baseQuery(db, orgId).where("t.id", "in", unique).execute();
  const linked = new Set(
    rows.filter((r) => r.platform_template_id !== null && r.pinned_version === null),
  );
  const known = new Set(rows.map((r) => r.id));
  const platformIds = [
    ...new Set([
      ...unique.filter((id) => !known.has(id)),
      ...[...linked].map((r) => r.platform_template_id as string),
    ]),
  ];
  const on = await platformOn(db, orgId, platformIds, log);
  const platform = new Map(on.rows.map((p) => [p.id, p]));
  const owned = await ownedPlatformIds(
    db,
    orgId,
    [...linked].map((r) => r.platform_template_id as string),
  );
  // ruling P2-18: a pinned copy serves its own version while its platform template is on
  const pinnedOn = await pinnedTemplateLinksServed(db, orgId, [
    ...new Set(
      rows.flatMap((r) =>
        r.platform_template_id !== null && r.pinned_version !== null
          ? [r.platform_template_id]
          : [],
      ),
    ),
  ]);
  // a selected platform id shadowed by an org row of the same component resolves to that row
  const shadowIds = unique.filter((id) => !known.has(id) && on.shadowed.has(id));
  const shadowRows = new Map(
    (shadowIds.length === 0
      ? []
      : await baseQuery(db, orgId)
          .where("t.id", "in", [...new Set(shadowIds.map((id) => on.shadowed.get(id) as string))])
          .execute()
    ).map((r) => [r.id, orgRaw(r)]),
  );
  const raw: { key: string; row: RawRow }[] = [];
  for (const r of rows) {
    if (linked.has(r)) {
      const p = platform.get(r.platform_template_id as string);
      if (!p) continue;
      if (!owned.has(p.id)) {
        raw.push({ key: r.id, row: { ...p, id: r.id } });
      } else if (r.current_version === p.version) {
        // the org's own template, promoted (ruling P3-3) at the same version: its own stored
        // version, so the roster and `subagent_started` see what they saw before
        raw.push({ key: r.id, row: orgRaw(r) });
      } else {
        // a newer platform version: under its id, with the copy's roster type
        raw.push({ key: r.id, row: { ...p, id: r.id, plugin: r.plugin_name, ownedCopy: true } });
      }
      continue;
    }
    if (r.platform_template_id !== null && !pinnedOn.has(r.platform_template_id)) continue;
    raw.push({ key: r.id, row: orgRaw(r) });
  }
  for (const id of unique) {
    if (known.has(id)) continue;
    const p = platform.get(id);
    if (p) {
      raw.push({ key: id, row: p });
      continue;
    }
    const o = shadowRows.get(on.shadowed.get(id) ?? "");
    if (o) raw.push({ key: id, row: o });
  }
  const done = await normalized(
    db,
    orgId,
    raw.map((x) => x.row),
  );
  return new Map(raw.map((x, i) => [x.key, done[i] as TemplateRow]));
}

/**
 * The org's usable templates, by plugin (none first), name and id: its own live templates
 * (unlinked, or pinned while their platform template is on in the org, ruling P2-18) and the platform templates on in the org (see {@link platformOn}). An org
 * copy linked without a pin is not listed: its platform template is; except the org's own template
 * it promoted (ruling P3-3), listed once under its own id instead of the platform template. `log`
 * receives the type-clash warnings.
 */
export async function usableTemplates(
  db: KernelSchemaDb,
  orgId: string,
  log?: Pick<Logger, "warn">,
): Promise<TemplateRow[]> {
  const own = await baseQuery(db, orgId)
    .where((eb) =>
      eb.or([eb("t.platform_template_id", "is", null), eb("t.pinned_version", "is not", null)]),
    )
    .execute();
  // ruling P2-18: a pinned copy follows its platform template's availability (the pin fixes the
  // version only)
  const pinnedOn = await pinnedTemplateLinksServed(db, orgId, [
    ...new Set(
      own.flatMap((r) => (r.platform_template_id === null ? [] : [r.platform_template_id])),
    ),
  ]);
  // the org's own templates it promoted: under their own ids, instead of their platform templates
  const promoted = await db
    .selectFrom("agent_templates as t")
    .innerJoin("platform_agent_templates as p", "p.id", "t.platform_template_id")
    .select(["t.id", "t.platform_template_id"])
    .where("t.org_id", "=", orgId)
    .where("t.deleted_at", "is", null)
    .where("t.pinned_version", "is", null)
    .where("p.owner_org_id", "=", orgId)
    .where("p.deleted_at", "is", null)
    .execute();
  const promotedTo = new Set(promoted.map((r) => r.platform_template_id as string));
  const served =
    promoted.length === 0
      ? []
      : [
          ...(
            await loadTemplates(
              db,
              orgId,
              promoted.map((r) => r.id),
              log,
            )
          ).values(),
        ];
  const rows = [
    ...(await normalized(db, orgId, [
      ...own
        .filter((r) => r.platform_template_id === null || pinnedOn.has(r.platform_template_id))
        .map(orgRaw),
      ...(await platformOn(db, orgId, undefined, log)).rows.filter((p) => !promotedTo.has(p.id)),
    ])),
    ...served,
  ];
  const key = (t: TemplateRow) => [t.plugin ?? "", t.name, t.id] as const;
  return rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1;
    }
    return 0;
  });
}

/**
 * The listing view of a usable template; `linkedIds`: the org's unpinned copies linked to it (a
 * platform template only).
 */
export function templateViewOf(t: TemplateRow, linkedIds: string[]): AgentTemplateView {
  return {
    id: t.id,
    name: t.name,
    plugin: t.plugin,
    type: templateTypeOf(t.plugin, t.name),
    description: typeof t.template.description === "string" ? t.template.description : "",
    model: t.template.model ?? "inherit",
    version: t.version,
    sourceFormat: t.sourceFormat,
    catalogItemId: t.catalogItemId,
    catalogVersion: t.catalogVersion,
    // the org's own template it promoted is the org's own, whatever version it serves
    origin: t.ownedCopy ? "org" : t.origin,
    ...(t.origin === "platform" && !t.ownedCopy && { linkedIds }),
  };
}

/** Reads the org's agent templates (consumed by the roster, the agent page and Task 19's API). */
@Injectable()
export class AgentTemplatesService {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /**
   * Every usable template of the org ({@link usableTemplates}), by plugin then name; a platform
   * template carries the ids of the org's unpinned copies linked to it (`linkedIds`).
   */
  async listForOrg(orgId: string): Promise<AgentTemplateView[]> {
    const usable = await usableTemplates(this.db.db, orgId);
    const platformIds = usable.filter((t) => t.origin === "platform").map((t) => t.id);
    const links =
      platformIds.length === 0
        ? []
        : await this.db.db
            .selectFrom("agent_templates")
            .select(["id", "platform_template_id"])
            .where("org_id", "=", orgId)
            .where("deleted_at", "is", null)
            .where("pinned_version", "is", null)
            .where("platform_template_id", "in", platformIds)
            .orderBy("id")
            .execute();
    const linked = new Map<string, string[]>();
    for (const l of links) {
      const k = l.platform_template_id as string;
      linked.set(k, [...(linked.get(k) ?? []), l.id]);
    }
    return usable.map((t) => templateViewOf(t, linked.get(t.id) ?? []));
  }

  /** A usable template by id or by its roster type; null when there is none. */
  async resolve(
    orgId: string,
    ref: string,
  ): Promise<{
    id: string;
    version: number;
    plugin: string | null;
    template: AgentTemplate;
  } | null> {
    const t =
      (await loadTemplates(this.db.db, orgId, [ref])).get(ref) ??
      (await usableTemplates(this.db.db, orgId)).find(
        (u) => templateTypeOf(u.plugin, u.name) === ref,
      );
    if (!t) return null;
    return { id: t.id, version: t.version, plugin: t.plugin, template: t.template };
  }
}

/**
 * Where a template version comes from: a plugin version of the catalog, or (ruling P4-9) the org
 * itself (另存为模板, an edit of an org template): `plugin`, `catalogItemId` and `catalogVersion`
 * null.
 */
export interface TemplateSource {
  orgId: string;
  plugin: string | null;
  /** The catalog item of the plugin; absent or null for an org template (ruling P4-9). */
  catalogItemId?: string | null;
  catalogVersion: string | null;
  sourceFormat: SourceFormat;
}

/**
 * Writes `template` as the org's live template `<plugin>:<name>` (the bare `<name>` when `plugin`
 * is null) in the caller's transaction (the caller holds the org row lock): a new template
 * (version 1, `created`), a new version of the live one when its definition differs (`changed`,
 * the version added), or nothing when it is equal.
 */
export async function putTemplateVersionIn(
  t: KernelSchemaDb,
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
    .where((eb) =>
      s.plugin === null ? eb("a.plugin_name", "is", null) : eb("a.plugin_name", "=", s.plugin),
    )
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
        catalog_item_id: s.catalogItemId ?? null,
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
      .set({
        current_version: version,
        catalog_item_id: s.catalogItemId ?? null,
        updated_at: new Date(),
      })
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
  t: KernelSchemaDb,
  orgId: string,
  id: string,
  version: number,
): Promise<boolean> {
  if (version <= 1) return false;
  // catalog_item_id is not restored (skills.revertVersionIn does restore its own): a template's
  // versions all come from the one catalog item of its plugin name, so it never changes
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
export async function softDeleteTemplateIn(
  t: KernelSchemaDb,
  orgId: string,
  id: string,
): Promise<boolean> {
  const r = await t
    .updateTable("agent_templates")
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}
