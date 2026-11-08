// Component scope (plugin scope phase 2, Task 6; spec §5 rules 2, 5, 8, 10, 11, §13.5): when a platform
// component (skill, agent template, connector template) is on in an org, offered to it, or locked on,
// and which agents of an org use one. Pure predicates plus the reads they need; the usable sets
// (skills/usable.ts, agents/templates.ts), the component scope service and the plugin scope preview
// all decide with the same predicates.
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { type PluginScope, visibleTo, wantedOn } from "./scope.js";

/** The kinds of platform components. */
export type ComponentKind = "skill" | "agent_template" | "connector_template";

export const COMPONENT_KINDS: readonly ComponentKind[] = [
  "skill",
  "agent_template",
  "connector_template",
];

/** A component's own scope settings (ruling C2). */
export interface ComponentScopeFacts {
  scopeMode: "follow" | "own";
  scope: PluginScope;
  disabled: boolean;
  /** The plugin it came from; null for a component without one. */
  itemId: string | null;
  /**
   * A connector template whose file says `defaultEnabled: false`: while it follows its plugin it
   * is off in an org until the org's switch turns it on (not for a builtin plugin).
   */
  defaultOff?: boolean;
}

/**
 * The component's plugin as one org sees it: `live` false for a deleted plugin; `listed` the org on
 * the plugin's `named` list; `installed` a live install of the plugin in the org.
 */
export interface PluginFacts {
  live: boolean;
  disabled: boolean;
  builtin: boolean;
  scope: PluginScope;
  listed: boolean;
  installed: boolean;
}

/** The component or its plugin stops it everywhere: disabled, or the plugin disabled or deleted. */
function stopped(c: ComponentScopeFacts, p: PluginFacts | null): boolean {
  if (c.disabled) return true;
  if (c.itemId === null) return false;
  return p === null || !p.live || p.disabled;
}

/**
 * Whether the component is on in the org (`listed`: the org on the component's own `named` list;
 * `sw`: the org's component switch):
 * - never when the component or its plugin is disabled, or its plugin is deleted;
 * - `follow`: its plugin is on in the org (a live install, or builtin) and the switch is not off
 *   (a `defaultOff` template of a plugin that is not builtin: the switch is on);
 * - `own`: `wantedOn` over the component's own scope, the list and the switch.
 */
export function componentOn(
  c: ComponentScopeFacts,
  p: PluginFacts | null,
  listed: boolean,
  sw: boolean | null,
): boolean {
  if (stopped(c, p)) return false;
  if (c.scopeMode === "follow") {
    const defaultOff = c.defaultOff === true && p?.builtin !== true;
    return componentPluginOn(c, p) && (defaultOff ? sw === true : sw !== false);
  }
  return wantedOn({ scope: c.scope, disabled: false, builtin: false }, listed, sw);
}

/**
 * Whether the plugin a component follows is on in the org (a live install there, or builtin); a
 * component with its own scope does not depend on it (true). A `follow` component comes on and off
 * with its plugin (spec §5 rule 5), so its own switch only matters while this holds.
 */
export function componentPluginOn(c: ComponentScopeFacts, p: PluginFacts | null): boolean {
  if (c.scopeMode === "own") return true;
  return p !== null && p.live && (p.installed || p.builtin);
}

/**
 * Whether the component is offered to the org: on, or an org admin could turn it on there (spec
 * §5 rule 10 refuses an org skill named like one). Not when it or its plugin is stopped; `follow`:
 * its plugin is visible to the org (builtin, `all`, `optional`, or `named` listing the org); `own`:
 * its own scope is visible to the org.
 */
export function componentOffered(
  c: ComponentScopeFacts,
  p: PluginFacts | null,
  listed: boolean,
): boolean {
  if (stopped(c, p)) return false;
  if (c.scopeMode === "follow") {
    return p !== null && (p.builtin || visibleTo({ scope: p.scope }, p.listed));
  }
  return visibleTo({ scope: c.scope }, listed);
}

/**
 * Whether the component belongs to a builtin plugin: an org admin cannot switch it off
 * (`plugin.scope_locked`, spec §13.5 as amended by the layering spec §4; an effective scope of
 * `all`, its own or its plugin's, is switchable like a listed `named` one).
 */
export function componentLocked(_c: ComponentScopeFacts, p: PluginFacts | null): boolean {
  return p?.builtin === true;
}

/** A live platform component with its scope settings. */
export interface ComponentRow extends ComponentScopeFacts {
  kind: ComponentKind;
  id: string;
  /** Skill or template name; a connector template's id (the file's base name). */
  name: string;
  /** The plugin's name (a connector template: its catalog item's). */
  plugin: string | null;
  /** The current version (a connector template: the catalog version that last changed it). */
  version: string;
  description: string | null;
  /**
   * A connector template's localized display name (its file's `displayName`); null for skills and
   * agent templates, whose name is what they are shown by.
   */
  displayName: { zh: string; en: string } | null;
  shownToOthers: boolean;
  /** The owning org (null: the platform; ruling P3-1). */
  ownerOrgId: string | null;
  /** The org it was created in (skills, agent templates; null: the platform, F27). */
  originOrgId: string | null;
  /** Its owner shares it with other orgs (the share gate, P3-1). */
  shareable: boolean;
}

/** A `{ zh, en }` display name from stored JSON (a template file's), else null. */
function localizedName(v: unknown): { zh: string; en: string } | null {
  const n = v as { zh?: unknown; en?: unknown } | null | undefined;
  return typeof n?.zh === "string" && typeof n.en === "string" ? { zh: n.zh, en: n.en } : null;
}

/** The live platform components of `kind` (`ids` / `itemId`: only those). */
export async function loadComponents(
  db: KernelSchemaDb,
  kind: ComponentKind,
  filter: { ids?: readonly string[]; itemId?: string; name?: string; forUpdate?: boolean } = {},
): Promise<ComponentRow[]> {
  if (filter.ids !== undefined && filter.ids.length === 0) return [];
  const common = (r: {
    id: string;
    catalog_item_id: string | null;
    scope_mode: "follow" | "own";
    scope: PluginScope;
    disabled: boolean;
    shown_to_others: boolean;
    owner_org_id: string | null;
    shareable: boolean;
  }) => ({
    kind,
    id: r.id,
    itemId: r.catalog_item_id,
    scopeMode: r.scope_mode,
    scope: r.scope,
    disabled: r.disabled,
    shownToOthers: r.shown_to_others,
    ownerOrgId: r.owner_org_id,
    shareable: r.shareable,
  });
  if (kind === "connector_template") {
    let q = db
      .selectFrom("platform_connector_templates as p")
      .leftJoin("catalog_items as c", "c.id", "p.catalog_item_id")
      .select([
        "p.id",
        "p.catalog_item_id",
        "p.template_id",
        "p.current_version",
        "p.scope_mode",
        "p.scope",
        "p.disabled",
        "p.shown_to_others",
        "p.owner_org_id",
        "p.shareable",
        "p.file",
        "c.name as item_name",
      ])
      .where("p.deleted_at", "is", null);
    if (filter.ids !== undefined) q = q.where("p.id", "in", [...filter.ids]);
    if (filter.itemId !== undefined) q = q.where("p.catalog_item_id", "=", filter.itemId);
    if (filter.name !== undefined) q = q.where("p.template_id", "=", filter.name);
    if (filter.forUpdate) q = q.forUpdate("p");
    return (await q.orderBy("p.id").execute()).map((r) => {
      const file = r.file as {
        defaultEnabled?: unknown;
        displayName?: unknown;
        description?: unknown;
      } | null;
      return {
        ...common(r),
        ...(file?.defaultEnabled === false && { defaultOff: true }),
        name: r.template_id,
        plugin: r.item_name,
        version: r.current_version,
        description: typeof file?.description === "string" ? file.description : null,
        displayName: localizedName(file?.displayName),
        originOrgId: null,
      };
    });
  }
  const table = kind === "skill" ? "platform_skills" : "platform_agent_templates";
  let q = db
    .selectFrom(`${table as "platform_skills"} as p`)
    .select([
      "p.id",
      "p.catalog_item_id",
      "p.plugin_name",
      "p.name",
      "p.description",
      "p.current_version",
      "p.scope_mode",
      "p.scope",
      "p.disabled",
      "p.shown_to_others",
      "p.owner_org_id",
      "p.origin_org_id",
      "p.shareable",
    ])
    .where("p.deleted_at", "is", null);
  if (filter.ids !== undefined) q = q.where("p.id", "in", [...filter.ids]);
  if (filter.itemId !== undefined) q = q.where("p.catalog_item_id", "=", filter.itemId);
  if (filter.name !== undefined) q = q.where("p.name", "=", filter.name);
  if (filter.forUpdate) q = q.forUpdate();
  return (await q.orderBy("p.id").execute()).map((r) => ({
    ...common(r),
    name: r.name,
    plugin: r.plugin_name,
    version: String(r.current_version),
    description: r.description as string | null,
    displayName: null,
    originOrgId: r.origin_org_id,
  }));
}

/** The plugin, scope list and switch facts of components, for every org (one read each). */
export interface ScopeState {
  plugins: Map<string, { scope: PluginScope; builtin: boolean; disabled: boolean }>;
  pluginListed: Map<string, Set<string>>;
  installed: Map<string, Set<string>>;
  listed: Map<string, Set<string>>;
  switches: Map<string, Map<string, boolean>>;
}

const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

const groupBy = <T>(rows: T[], key: (r: T) => string, value: (r: T) => string) => {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = key(r);
    const s = out.get(k) ?? new Set<string>();
    out.set(k, s);
    s.add(value(r));
  }
  return out;
};

/** Reads the {@link ScopeState} of `comps` (all of one kind), one query after the other. */
export async function loadScopeState(
  db: KernelSchemaDb,
  kind: ComponentKind,
  comps: readonly { id: string; itemId: string | null }[],
): Promise<ScopeState> {
  const itemIds = [...new Set(comps.map((c) => c.itemId).filter((x): x is string => x !== null))];
  const ids = comps.map((c) => c.id);
  const state: ScopeState = {
    plugins: new Map(),
    pluginListed: new Map(),
    installed: new Map(),
    listed: new Map(),
    switches: new Map(),
  };
  if (itemIds.length > 0) {
    const items = await db
      .selectFrom("catalog_items")
      .select(["id", "scope", "builtin", "disabled"])
      .where("id", "in", itemIds)
      .where("deleted_at", "is", null)
      .execute();
    for (const i of items) state.plugins.set(i.id, i);
    const listed = await db
      .selectFrom("catalog_item_scope_orgs")
      .select(["item_id", "org_id"])
      .where("item_id", "in", itemIds)
      .execute();
    state.pluginListed = groupBy(
      listed,
      (r) => r.item_id,
      (r) => r.org_id,
    );
    const installs = await db
      .selectFrom("plugin_installs")
      .select(["item_id", "org_id"])
      .where("item_id", "in", itemIds)
      .where("status", "in", [...LIVE_INSTALL])
      .execute();
    state.installed = groupBy(
      installs,
      (r) => r.item_id,
      (r) => r.org_id,
    );
  }
  if (ids.length > 0) {
    const listed = await db
      .selectFrom("component_scope_orgs")
      .select(["component_id", "org_id"])
      .where("kind", "=", kind)
      .where("component_id", "in", ids)
      .execute();
    state.listed = groupBy(
      listed,
      (r) => r.component_id,
      (r) => r.org_id,
    );
    const switches = await db
      .selectFrom("component_org_switches")
      .select(["component_id", "org_id", "enabled"])
      .where("kind", "=", kind)
      .where("component_id", "in", ids)
      .execute();
    for (const s of switches) {
      const m = state.switches.get(s.component_id) ?? new Map<string, boolean>();
      state.switches.set(s.component_id, m);
      m.set(s.org_id, s.enabled);
    }
  }
  return state;
}

/** The plugin facts of `itemId` for one org from a {@link ScopeState} (null: no plugin). */
export function pluginFactsOf(
  st: ScopeState,
  itemId: string | null,
  orgId: string,
): PluginFacts | null {
  if (itemId === null) return null;
  const p = st.plugins.get(itemId);
  if (!p)
    return {
      live: false,
      disabled: false,
      builtin: false,
      scope: "optional",
      listed: false,
      installed: false,
    };
  return {
    live: true,
    disabled: p.disabled,
    builtin: p.builtin,
    scope: p.scope,
    listed: st.pluginListed.get(itemId)?.has(orgId) ?? false,
    installed: st.installed.get(itemId)?.has(orgId) ?? false,
  };
}

/** The org's switch of a component from a {@link ScopeState}. */
export const switchOf = (st: ScopeState, id: string, orgId: string): boolean | null =>
  st.switches.get(id)?.get(orgId) ?? null;

/** Whether the org is on a component's own `named` list in a {@link ScopeState}. */
export const listedIn = (st: ScopeState, id: string, orgId: string): boolean =>
  st.listed.get(id)?.has(orgId) ?? false;

/** The connectors, skills and agent templates an agent definition references. */
export interface DefinitionRefs {
  /**
   * The connectors the agent uses: tools are on by default (tools default-on spec §6), so every
   * one of `orgConnectors` it does not turn off as a whole.
   */
  connectors: Set<string>;
  /** `skills.orgSkills`, `skills.pinned` and the inline sub-agent templates' `skills`. */
  skills: Set<string>;
  /** `subagents.templates`. */
  templates: Set<string>;
}

/**
 * The ids an agent definition references (see {@link DefinitionRefs}); `orgConnectors` are the
 * ids of the org's live connectors.
 */
export function definitionRefs(
  definition: unknown,
  orgConnectors: readonly string[] = [],
): DefinitionRefs {
  const def = definition as {
    disabledTools?: unknown[];
    skills?: { orgSkills?: unknown[]; pinned?: unknown[] };
    subagents?: { templates?: unknown[]; inline?: { skills?: unknown[] }[] };
  } | null;
  const connectors = new Set<string>();
  const skills = new Set<string>();
  const templates = new Set<string>();
  const off = new Set<string>();
  for (const ref of Array.isArray(def?.disabledTools) ? def.disabledTools : []) {
    const n = ref as { kind?: unknown; connectorId?: unknown; tools?: unknown } | null;
    if (n?.kind === "connector" && typeof n.connectorId === "string" && n.tools === "all") {
      off.add(n.connectorId);
    }
  }
  for (const id of orgConnectors) if (!off.has(id)) connectors.add(id);
  const strings = (xs: unknown, into: Set<string>) => {
    if (Array.isArray(xs)) for (const x of xs) if (typeof x === "string") into.add(x);
  };
  strings(def?.skills?.orgSkills, skills);
  strings(def?.skills?.pinned, skills);
  const inline = def?.subagents?.inline;
  if (Array.isArray(inline)) for (const t of inline) strings(t?.skills, skills);
  strings(def?.subagents?.templates, templates);
  return { connectors, skills, templates };
}

/** The org's live agents with their current definitions' references, sorted by id. */
export async function agentDefinitionRefs(
  db: KernelSchemaDb,
  orgId: string,
): Promise<({ id: string; name: string } & DefinitionRefs)[]> {
  const rows = await db
    .selectFrom("agents as a")
    .innerJoin("agent_versions as v", (j) =>
      j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
    )
    .select(["a.id", "v.definition"])
    .where("a.org_id", "=", orgId)
    .where("a.deleted_at", "is", null)
    .orderBy("a.id")
    .execute();
  const connectors = (
    await db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .execute()
  ).map((c) => c.id);
  return rows.map((r) => {
    const name = (r.definition as { name?: unknown } | null)?.name;
    return {
      id: r.id,
      name: typeof name === "string" ? name : r.id,
      ...definitionRefs(r.definition, connectors),
    };
  });
}

/**
 * The ids an org's agents may reference a platform component by: its own id and the org's copies
 * linked to it (ruling B2: unpinned ones resolve to it; ruling P2-18: pinned ones follow its
 * availability). Connector templates: none (connectors made from one stay the org's own).
 */
export async function referenceIds(
  db: KernelSchemaDb,
  orgId: string,
  kind: ComponentKind,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (kind === "connector_template" || ids.length === 0) return out;
  for (const id of ids) out.set(id, id);
  const copies =
    kind === "skill"
      ? await db
          .selectFrom("skills")
          .select(["id", "platform_skill_id as platform_id"])
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where("platform_skill_id", "in", [...ids])
          .execute()
      : await db
          .selectFrom("agent_templates")
          .select(["id", "platform_template_id as platform_id"])
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where("platform_template_id", "in", [...ids])
          .execute();
  for (const c of copies) if (c.platform_id !== null) out.set(c.id, c.platform_id);
  return out;
}

/**
 * The org's agents that use any of the components `ids` of `kind`, each with the references it
 * uses (`ref`: the id in its definition), sorted by id.
 */
export async function agentsUsing(
  db: KernelSchemaDb,
  orgId: string,
  kind: ComponentKind,
  ids: readonly string[],
): Promise<{ id: string; name: string; refs: string[] }[]> {
  const refs = await referenceIds(db, orgId, kind, ids);
  if (refs.size === 0) return [];
  const out: { id: string; name: string; refs: string[] }[] = [];
  for (const a of await agentDefinitionRefs(db, orgId)) {
    const used = kind === "skill" ? a.skills : a.templates;
    const hit = [...used].filter((r) => refs.has(r)).sort();
    if (hit.length > 0) out.push({ id: a.id, name: a.name, refs: hit });
  }
  return out;
}

/**
 * The org's own skills (live, `scope = 'org'`, unlinked or pinned) named `name` that are not a copy
 * of platform skill `component` (linked to it, or from its plugin): a clash under rule 10.
 */
export async function clashingOrgSkills(
  db: KernelSchemaDb,
  orgId: string,
  component: { id: string; itemId: string | null },
  name: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("skills")
    .select(["id", "platform_skill_id", "catalog_item_id"])
    .where("org_id", "=", orgId)
    .where("scope", "=", "org")
    .where("deleted_at", "is", null)
    .where("name", "=", name)
    .where((eb) =>
      eb.or([eb("platform_skill_id", "is", null), eb("pinned_version", "is not", null)]),
    )
    .execute();
  return rows
    .filter(
      (r) =>
        r.platform_skill_id !== component.id &&
        !(r.catalog_item_id !== null && r.catalog_item_id === component.itemId),
    )
    .map((r) => r.id);
}

/** The platform components of `kind` named `name` that are offered to the org ({@link componentOffered}). */
export async function offeredNamed(
  db: KernelSchemaDb,
  orgId: string,
  kind: ComponentKind,
  name: string,
): Promise<ComponentRow[]> {
  const comps = await loadComponents(db, kind, { name });
  if (comps.length === 0) return [];
  const st = await loadScopeState(db, kind, comps);
  return comps.filter((c) =>
    componentOffered(c, pluginFactsOf(st, c.itemId, orgId), listedIn(st, c.id, orgId)),
  );
}

/** The other platform skills named `name` that are on in the org (rule 10). */
export async function clashingPlatformSkills(
  db: KernelSchemaDb,
  orgId: string,
  component: { id: string },
  name: string,
): Promise<ComponentRow[]> {
  const others = (await loadComponents(db, "skill", { name })).filter((c) => c.id !== component.id);
  if (others.length === 0) return [];
  const st = await loadScopeState(db, "skill", others);
  return others.filter((c) =>
    componentOn(
      c,
      pluginFactsOf(st, c.itemId, orgId),
      listedIn(st, c.id, orgId),
      switchOf(st, c.id, orgId),
    ),
  );
}

/**
 * The skills that already use the name of platform skill `component` in the org (rule 10): the
 * org's own ({@link clashingOrgSkills}) and other platform skills on there (`plugins`: theirs).
 */
export async function skillNameClashes(
  db: KernelSchemaDb,
  orgId: string,
  component: { id: string; itemId: string | null },
  name: string,
): Promise<{ skills: string[]; plugins: string[] }> {
  const platform = await clashingPlatformSkills(db, orgId, component, name);
  return {
    skills: [
      ...(await clashingOrgSkills(db, orgId, component, name)),
      ...platform.map((c) => c.id),
    ],
    plugins: platform.map((c) => c.plugin ?? "platform"),
  };
}

/** A connector template's id from its manifest path (`./connectors/<id>.json`). */
export const templateIdOfPath = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.json$/, "");

/**
 * The connector templates among `ids` (of catalog item `itemId`) that are on in the org once the
 * plugin is on there (ruling P2-6): the component switch, its own scope and disabled flags decide;
 * a template without a platform row counts as on. Installs create connectors only from these, and
 * only these need the org's input (`needs_config`). `defaultOff`: by template id, whether another
 * version's file (an update's target) ships it off, in place of the platform row's.
 */
export async function connectorTemplatesOn(
  db: KernelSchemaDb,
  orgId: string,
  itemId: string,
  ids: readonly string[],
  defaultOff?: ReadonlyMap<string, boolean>,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const comps = await loadComponents(db, "connector_template", { itemId });
  const st = await loadScopeState(db, "connector_template", comps);
  const off = new Set(
    comps
      .filter((c) => {
        const p = pluginFactsOf(st, c.itemId, orgId);
        const shipped = defaultOff?.get(c.name);
        return !componentOn(
          shipped === undefined ? c : { ...c, defaultOff: shipped },
          p && { ...p, installed: true },
          listedIn(st, c.id, orgId),
          switchOf(st, c.id, orgId),
        );
      })
      .map((c) => c.name),
  );
  return new Set(ids.filter((id) => !off.has(id)));
}

/** The org's live connectors made from platform connector template `id` (they stay its own). */
export async function connectorsMadeFrom(
  db: KernelSchemaDb,
  orgId: string,
  id: string,
): Promise<number> {
  const r = await db
    .selectFrom("connectors")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("platform_template_id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Whether platform connector template `id` is on in the org (`on`), offered to it but off
 * (`off`: its plugin not installed for a `follow` template, or switched off there), or neither
 * (`absent`: missing, deleted, without a plugin, stopped or not offered). One more connector from a
 * template needs `on` (ruling P4-T6-8), read before and again under the org lock.
 */
export async function connectorTemplateState(
  db: KernelSchemaDb,
  orgId: string,
  id: string,
): Promise<"on" | "off" | "absent"> {
  const [c] = await loadComponents(db, "connector_template", { ids: [id] });
  if (!c || c.itemId === null) return "absent";
  const st = await loadScopeState(db, "connector_template", [c]);
  const p = pluginFactsOf(st, c.itemId, orgId);
  const listed = listedIn(st, c.id, orgId);
  if (componentOn(c, p, listed, switchOf(st, c.id, orgId))) return "on";
  return componentOffered(c, p, listed) ? "off" : "absent";
}
