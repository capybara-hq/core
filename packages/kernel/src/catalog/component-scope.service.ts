import { createHash } from "node:crypto";
import type { LocalizedName, ThemeScheme } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { templateTypeClashes, templateTypeOf } from "../agents/templates.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { notifyItemShared } from "../inbox/org-notices.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import type { OrgAction } from "../orgs/roles.js";
import { type ThemeSwatch, themeDefinitions, themeSwatches } from "../themes/theme-state.js";
import {
  assertNotPlatformDefault,
  platformDefaultThemeId,
  type ThemeAfter,
  type ThemePreview,
  themesPreview,
} from "../themes/theme-usage.js";
import type { ActorOpts } from "./catalog.service.js";
import { assertOrgsExist } from "./catalog-items.js";
import {
  ComponentPromotion,
  notOwnedError,
  type OrgRow,
  PROMOTION_ATTEMPTS,
  type PreparedPromotion,
  PromotionStale,
  promotionStaleError,
} from "./component-promotion.js";
import {
  agentsUsing,
  COMPONENT_KINDS,
  type ComponentKind,
  type ComponentRow,
  type ComponentScopeFacts,
  componentLocked,
  componentOffered,
  componentOn,
  componentPluginOn,
  connectorsMadeFrom,
  listedIn,
  loadComponents,
  loadScopeState,
  type PluginFacts,
  pluginFactsOf,
  type ScopeState,
  skillNameClashes,
  switchOf,
  themeIdClashes,
} from "./component-state.js";
import {
  assertOwnerListed,
  assertShareable,
  assertShareableTarget,
  newlySharedWith,
  type Owner,
  ownerOf,
  ownersOf,
} from "./ownership.js";
import type { PluginScope } from "./scope.js";

/**
 * What a component scope change, a component disable or a switch back to its plugin's scope would
 * do (spec §5 rules 8 and 10): the orgs where it is on now and would be off, with their agents that
 * use it (by its id or an org copy linked to it), and the orgs it would newly be offered to whose
 * own skills already use its name (the change is refused while there are any). `scopeHash` is
 * confirmed with the change.
 */
export interface ComponentScopePreview {
  affected: {
    orgId: string;
    orgName: string;
    agents: { id: string; name: string }[];
    /** A connector template: the org's connectors made from it, which stay as the org's own. */
    connectorsKept: number;
  }[];
  /**
   * `skills`: the clashing skill ids (org skills, other platform skills; for an agent template the
   * clashing template ids, `name` its roster type, ruling P4-13); `plugins`: theirs.
   */
  conflicts: {
    orgId: string;
    orgName: string;
    name: string;
    skills: string[];
    plugins: string[];
    /** An agent template's: the owner of each clashing template, in `skills`' order. */
    owners?: Owner[];
    /** A theme's: the clashing themes on in the org (`skills` then empty). */
    themes?: string[];
  }[];
  /**
   * A theme the change takes away from some orgs (themes spec §6): the orgs among them whose
   * default it is and how many people picked it. Absent when no theme is taken away.
   */
  themes?: ThemePreview[];
  scopeHash: string;
}

/** A component's own scope (`orgs` only with `named`), a disable, or following its plugin again. */
export type ComponentTarget =
  | { scope: PluginScope; orgs?: string[] }
  | { disabled: boolean }
  | { follow: true };

/**
 * A component in the admin list (`GET admin/components`): a platform component, or (ruling P2-11)
 * an org's own skill or agent template, listed read-only (`owner` = the org; its scope fields
 * say it is on in that org only; scope, disable and uploads are platform-only, 404 for it).
 */
export interface ComponentView {
  kind: ComponentKind;
  id: string;
  name: string;
  description: string | null;
  /** The plugin it came from (null: none). */
  plugin: string | null;
  itemId: string | null;
  /** The platform, or the org that owns it (ruling P3-1). */
  owner: Owner;
  /** Its owner shares it with other orgs (the share gate; always false for the platform's). */
  shareable: boolean;
  /**
   * A platform row created from an org's own skill or agent template when it was first shared
   * (promote on share, ruling P3-3); false for an org row and for a plugin's component.
   */
  promoted: boolean;
  /** Of a builtin plugin: on everywhere, its scope cannot be changed nor disabled (409). */
  builtin: boolean;
  scopeMode: "follow" | "own";
  /** The effective scope: the plugin's (builtin: `all`) when following it, else its own. */
  scope: PluginScope;
  /** The effective `named` list (the plugin's when following it), sorted. */
  orgs: string[];
  disabled: boolean;
  /** The plugin is disabled or deleted: the component is off everywhere. */
  pluginStopped: boolean;
  shownToOthers: boolean;
  version: string;
  /** The orgs it is on in now, sorted. */
  onIn: string[];
  /**
   * Orgs whose admin switched it off while its effective scope is `all` (layering spec §4); 0 for
   * other scopes, builtin plugins and orgs' own rows.
   */
  offCount: number;
  /** A theme: its name and swatches from its current version (absent for other kinds). */
  theme?: { name: LocalizedName; swatches: Partial<Record<ThemeScheme, ThemeSwatch>> };
}

/** One version of a platform component (`GET admin/components/:kind/:id/versions`). */
export interface ComponentVersionView {
  /** The component's own version counter (a connector template: its catalog version). */
  version: string;
  /** The plugin version it came from (null: uploaded on its own). */
  catalogVersion: string | null;
  /** Written by an upload of the component on its own (spec §7.2). */
  updatedOnOwn: boolean;
  createdAt: string;
}

/** An org's view of one component after its switch. */
export interface OrgComponentView {
  kind: ComponentKind;
  id: string;
  name: string;
  plugin: string | null;
  /** The org's switch (null: never switched). */
  switch: boolean | null;
  on: boolean;
  /**
   * Of a builtin plugin, or the platform default theme (themes spec §7): it cannot be switched off
   * (an `all` one can, layering spec §4).
   */
  locked: boolean;
}

/**
 * A platform component offered to an org (`GET orgs/:orgId/components`, Task 10): on there, or one
 * an org admin could switch on; what the workspace 技能 / 智能体模板 pages and the plugin detail
 * show with their switches. Never a component the org cannot see.
 */
export interface OrgOfferedComponentView extends OrgComponentView {
  description: string | null;
  itemId: string | null;
  version: string;
  scopeMode: "follow" | "own";
  /** A `follow` component's plugin is on in the org (always true for `own`). */
  pluginOn: boolean;
  /**
   * An org admin may switch it now: not locked, and (`follow`) its plugin is on in the org (a
   * component of a plugin that is off is switched on with the plugin, spec §5 rule 5).
   */
  switchable: boolean;
  /** On by platform default: the effective scope (its own, or its plugin's) is `all` and it is not builtin. */
  platformDefault: boolean;
  /**
   * The org's copies linked to it without a pin (skills, agent templates): agents that select one
   * of these ids use this component, and lose it while it is off (spec §5 rule 8).
   */
  linkedIds: string[];
  /**
   * The platform, or the org that owns it (an org's upload, ruling P3-1): what the workspace pages
   * name as its owner (本组织 for the viewing org's own, the owner's name for another org's).
   */
  owner: Owner;
}

/** The result of an org switch: the component, or (switching off without `confirm`) the preview. */
export type ComponentSwitchResult =
  | { kind: "done"; component: OrgComponentView }
  | {
      kind: "preview";
      preview: {
        agents: { id: string; name: string; refs: string[] }[];
        connectorsKept: number;
        /**
         * A theme: whether it is the org's default and how many of its members picked it (themes
         * spec §6). Absent for other kinds and for a theme nobody there chose.
         */
        themes?: ThemePreview[];
      };
      confirm: string;
    };

interface Target {
  scopeMode: "follow" | "own";
  scope: PluginScope;
  orgs: string[];
  disabled: boolean;
}

/** Actor facts of a write: the token, and detail the caller adds to the audit row. */
type AuditOpts = ActorOpts & { auditDetail?: Record<string, unknown> };

const notFound = () => new ApiError("component.not_found", "Component not found");
const staleError = () =>
  new ApiError(
    "plugin.scope_stale",
    "What this change affects has changed since the preview; preview it again and confirm the new hash",
  );
const builtinError = () =>
  new ApiError(
    "plugin.builtin",
    "This component belongs to a built-in plugin: it is on in every organization and its scope cannot be changed or disabled",
  );

/** The org action that manages a kind of component (the org admin's). */
const ACTION: Record<ComponentKind, OrgAction> = {
  skill: "skills.manage",
  agent_template: "agents.manage",
  connector_template: "connectors.manage",
  theme: "org.update",
};

/**
 * 409 `plugin.skill_conflict` listing the orgs whose own skills use a component's name (rule 10);
 * for a theme 409 `theme.id_taken` listing the orgs where another theme with its id is on (details
 * `[{ theme, orgId, themes, plugins }]`);
 * for an agent template 409 `agent_template.name_taken` listing the orgs that already use its
 * roster type (ruling P4-13; details `[{ orgId, type, templateId, owner }]`, one per clashing
 * template, `owner` as save-as names it).
 */
export function nameConflictError(
  conflicts: ComponentScopePreview["conflicts"],
  kind: ComponentKind = "skill",
): ApiError {
  if (kind === "theme") {
    return new ApiError(
      "theme.id_taken",
      conflicts
        .map(
          (c) =>
            `A theme with id ${c.name} is already on in organization ${c.orgName} (plugin "${c.plugins.join('", "')}"); one theme id cannot be on there twice. Switch that theme off there first.`,
        )
        .join("\n"),
      conflicts.map((c) => ({
        theme: c.name,
        orgId: c.orgId,
        themes: c.themes ?? [],
        plugins: c.plugins,
      })),
    );
  }
  if (kind === "agent_template") {
    // the save-as wording (ruling P4-9), naming each clashing template's owner
    const whose = (o: Owner | undefined, orgId: string) =>
      o === undefined || o.kind === "platform"
        ? "the platform's"
        : o.orgId === orgId
          ? "its own"
          : `from organization ${o.name}`;
    return new ApiError(
      "agent_template.name_taken",
      conflicts
        .map(
          (c) =>
            `An agent template named ${c.name} is already used in organization ${c.orgName} (${c.skills.map((_, i) => whose(c.owners?.[i], c.orgId)).join(", ")}); one name cannot be offered there twice.`,
        )
        .join("\n"),
      conflicts.flatMap((c) =>
        c.skills.map((templateId, i) => ({
          orgId: c.orgId,
          type: c.name,
          templateId,
          owner: c.owners?.[i] ?? { kind: "platform" },
        })),
      ),
    );
  }
  return new ApiError(
    "plugin.skill_conflict",
    conflicts
      .map(
        (c) =>
          `Skill "${c.name}" is already used in organization ${c.orgName} (${c.plugins.length > 0 ? `plugin "${c.plugins.join('", "')}"` : "its own skill"}); it would be offered there twice.`,
      )
      .join("\n"),
    conflicts.map((c) => ({
      skill: c.name,
      orgId: c.orgId,
      skills: c.skills,
      source:
        c.plugins.length > 0
          ? { kind: "plugin", name: c.plugins[0], version: "" }
          : { kind: "org" },
    })),
  );
}

/** The hash of a preview: sha256 over its sorted JSON, the target included. */
function previewHash(
  c: { kind: ComponentKind; id: string },
  target: Target,
  p: Omit<ComponentScopePreview, "scopeHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        component: { kind: c.kind, id: c.id },
        target: { ...target, orgs: [...target.orgs].sort() },
        affected: [...p.affected]
          .sort((a, b) => a.orgId.localeCompare(b.orgId))
          .map((a) => ({ ...a, agents: [...a.agents].sort((x, y) => x.id.localeCompare(y.id)) })),
        conflicts: [...p.conflicts].sort((a, b) => a.orgId.localeCompare(b.orgId)),
        // only when present: a preview without themes keeps the hash it had before themes
        ...(p.themes !== undefined && { themes: p.themes }),
      }),
    )
    .digest("hex");
}

/** The confirm hash of an org switch-off preview. */
function switchHash(
  orgId: string,
  c: { kind: ComponentKind; id: string },
  preview: { agents: { id: string; refs: string[] }[]; connectorsKept: number; themes?: unknown },
): string {
  return createHash("sha256")
    .update(JSON.stringify({ orgId, kind: c.kind, id: c.id, ...preview }))
    .digest("hex");
}

/**
 * Component scope and org switches (plugin scope phase 2, Task 6; spec §5 rules 2, 5, 8, 10, 11,
 * §13.5). The super admin gives a platform component its own scope (`all` / `optional` / `named`),
 * sends it back to following its plugin, disables it on the whole deployment or shows it to other
 * orgs; each change that takes something away is previewed and confirmed with `scopeHash`
 * (recomputed under the component row lock; a difference -> 409 `plugin.scope_stale`), and one that
 * would offer a skill to an org whose own skill has its name is refused (409 `plugin.skill_conflict`).
 * An org admin switches one component on or off in the org (only that component, rule 5); one of a
 * builtin plugin -> 409 `plugin.scope_locked` (an `all` one may go off, layering spec §4); switching
 * off something in use is previewed with its agents first.
 * Name clashes are checked for skills, agent templates by their roster type, and themes by their
 * id among the themes on in an org (themes spec §6). A change that would take the platform default
 * theme away from an org is refused (409 `theme.platform_default`, themes spec §7). Components are
 * resolved at read time (skills/usable.ts, agents/templates.ts), so nothing is enqueued.
 * Stateless, shared by every replica.
 */
@Injectable()
export class ComponentScopeService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** Promote on share (ruling P3-3): an org row shown or associated becomes a platform row. */
    @Inject(ComponentPromotion) private readonly promotion: ComponentPromotion,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * What the admin routes act on (ruling P3-23): the platform component `id`, an org row the org
   * promoted already (its platform row), or an org's own row not promoted yet. A connector
   * template or a theme has no org rows; anything else -> 404 `component.not_found`.
   */
  private async resolve(
    kind: ComponentKind,
    id: string,
  ): Promise<{ c: ComponentRow } | { org: OrgRow }> {
    const [c] = await loadComponents(this.db, kind, { ids: [id] });
    if (c) return { c };
    if (kind === "connector_template" || kind === "theme") throw notFound();
    const org = await this.promotion.orgRow(kind, id);
    if (!org) throw notFound();
    if (org.link === null) return { org };
    const [linked] = await loadComponents(this.db, kind, { ids: [org.link] });
    if (!linked) throw notFound();
    return { c: linked };
  }

  /**
   * Runs `write` with the org row prepared for promotion ({@link ComponentPromotion.prepare}, files
   * copied before the transaction), preparing again when the row changed meanwhile.
   */
  private async withPromotion<T>(
    kind: "skill" | "agent_template",
    orgRowId: string,
    write: (p: PreparedPromotion) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const prepared = await this.promotion.prepare(kind, orgRowId);
      try {
        return await write(prepared);
      } catch (e) {
        await this.promotion.discard(prepared);
        if (!(e instanceof PromotionStale)) throw e;
        if (attempt >= PROMOTION_ATTEMPTS) throw promotionStaleError();
      }
    }
  }

  /** The platform components of `kind`, with their effective scope and the orgs they are on in. */
  async list(kind: ComponentKind): Promise<ComponentView[]> {
    const comps = await loadComponents(this.db, kind);
    const st = await loadScopeState(this.db, kind, comps);
    const orgs = await this.liveOrgs();
    const owners = await ownersOf(
      this.db,
      comps.flatMap((c) => (c.ownerOrgId === null ? [] : [c.ownerOrgId])),
    );
    // a theme's name and swatches come from its current definition (the admin pickers, §10)
    const defs =
      kind === "theme"
        ? await themeDefinitions(
            this.db,
            comps.map((c) => c.id),
          )
        : null;
    const platform = comps.map((c): ComponentView => {
      const def = defs?.get(c.id)?.definition;
      const plugin = c.itemId === null ? undefined : st.plugins.get(c.itemId);
      const follow = c.scopeMode === "follow" && c.itemId !== null;
      const scope: PluginScope = follow
        ? plugin?.builtin
          ? "all"
          : (plugin?.scope ?? c.scope)
        : c.scope;
      const list = follow
        ? (st.pluginListed.get(c.itemId as string) ?? new Set<string>())
        : (st.listed.get(c.id) ?? new Set<string>());
      return {
        kind,
        id: c.id,
        name: c.name,
        description: c.description,
        plugin: c.plugin,
        itemId: c.itemId,
        owner: ownerOf(c.ownerOrgId, owners),
        shareable: c.shareable,
        promoted: c.itemId === null && c.originOrgId !== null,
        builtin: plugin?.builtin === true,
        scopeMode: c.scopeMode,
        scope,
        orgs: scope === "named" ? [...list].sort() : [],
        disabled: c.disabled,
        pluginStopped: c.itemId !== null && (plugin === undefined || plugin.disabled),
        shownToOthers: c.shownToOthers,
        version: c.version,
        onIn: orgs
          .filter((o) => this.on(c, st, o.id))
          .map((o) => o.id)
          .sort(),
        offCount:
          scope === "all" && plugin?.builtin !== true
            ? orgs.filter((o) => switchOf(st, c.id, o.id) === false).length
            : 0,
        ...(def !== undefined && { theme: { name: def.name, swatches: themeSwatches(def) } }),
      };
    });
    const owned = await this.orgOwned(kind, orgs);
    return [...platform, ...owned].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /**
   * The platform components offered to the org (`kind` / `itemId`: only those), by kind then name:
   * on there, or visible to it and not stopped on the deployment (spec §5 rules 5, 11, §13.5).
   */
  async orgList(
    orgId: string,
    filter: { kind?: ComponentKind; itemId?: string },
  ): Promise<OrgOfferedComponentView[]> {
    const out: OrgOfferedComponentView[] = [];
    // the platform default theme is locked on in every org (themes spec §7)
    const uiTheme = await platformDefaultThemeId(this.db);
    for (const kind of filter.kind !== undefined ? [filter.kind] : COMPONENT_KINDS) {
      const comps = await loadComponents(
        this.db,
        kind,
        filter.itemId !== undefined ? { itemId: filter.itemId } : {},
      );
      const st = await loadScopeState(this.db, kind, comps);
      const linked = await this.linkedCopies(orgId, kind);
      const owners = await ownersOf(
        this.db,
        comps.flatMap((c) => (c.ownerOrgId === null ? [] : [c.ownerOrgId])),
      );
      const rows: OrgOfferedComponentView[] = [];
      for (const c of comps) {
        const p = pluginFactsOf(st, c.itemId, orgId);
        const listed = listedIn(st, c.id, orgId);
        const sw = switchOf(st, c.id, orgId);
        const on = componentOn(c, p, listed, sw);
        if (!on && !componentOffered(c, p, listed)) continue;
        const locked = componentLocked(c, p) || isUiTheme(c, uiTheme);
        const pluginOn = componentPluginOn(c, p);
        rows.push({
          kind,
          id: c.id,
          name: c.name,
          description: c.description,
          plugin: c.plugin,
          itemId: c.itemId,
          version: c.version,
          scopeMode: c.scopeMode,
          switch: sw,
          on,
          locked,
          pluginOn,
          switchable: !locked && pluginOn,
          platformDefault:
            !locked && (c.scopeMode === "follow" ? p?.scope === "all" : c.scope === "all"),
          linkedIds: linked.get(c.id) ?? [],
          owner: ownerOf(c.ownerOrgId, owners),
        });
      }
      rows.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      out.push(...rows);
    }
    return out;
  }

  /**
   * The org's copies of platform skills or agent templates linked without a pin (ruling B2), by
   * platform id: they resolve to it, so agents that select them use it (none for connector
   * templates and themes).
   */
  private async linkedCopies(orgId: string, kind: ComponentKind): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (kind === "connector_template" || kind === "theme") return out;
    const rows =
      kind === "skill"
        ? await this.db
            .selectFrom("skills")
            .select(["id", "platform_skill_id as link"])
            .where("org_id", "=", orgId)
            .where("scope", "=", "org")
            .where("deleted_at", "is", null)
            .where("pinned_version", "is", null)
            .where("platform_skill_id", "is not", null)
            .orderBy("id")
            .execute()
        : await this.db
            .selectFrom("agent_templates")
            .select(["id", "platform_template_id as link"])
            .where("org_id", "=", orgId)
            .where("deleted_at", "is", null)
            .where("pinned_version", "is", null)
            .where("platform_template_id", "is not", null)
            .orderBy("id")
            .execute();
    for (const r of rows) {
      const k = r.link as string;
      out.set(k, [...(out.get(k) ?? []), r.id]);
    }
    return out;
  }

  /**
   * The orgs' own skills (org scope) and agent templates, not linked to a platform component
   * (ruling P2-11): listed read-only, on in their org only. Connector templates have none; an
   * org's own theme is a platform_themes row with its org as owner, listed with the platform ones.
   */
  private async orgOwned(
    kind: ComponentKind,
    orgs: { id: string; name: string }[],
  ): Promise<ComponentView[]> {
    if (kind === "connector_template" || kind === "theme") return [];
    const live = new Set(orgs.map((o) => o.id));
    const rows =
      kind === "skill"
        ? await this.db
            .selectFrom("skills as s")
            .leftJoin("catalog_items as c", "c.id", "s.catalog_item_id")
            .select([
              "s.id",
              "s.org_id",
              "s.name",
              "s.description",
              "s.current_version",
              "s.catalog_item_id",
              "s.shareable",
              "c.name as plugin",
            ])
            .where("s.scope", "=", "org")
            .where("s.deleted_at", "is", null)
            .where("s.platform_skill_id", "is", null)
            .execute()
        : (
            await this.db
              .selectFrom("agent_templates")
              .select([
                "id",
                "org_id",
                "name",
                "current_version",
                "catalog_item_id",
                "shareable",
                "plugin_name as plugin",
              ])
              .where("deleted_at", "is", null)
              .where("platform_template_id", "is", null)
              .execute()
          ).map((r) => ({ ...r, description: null as string | null }));
    const kept = rows.filter((r) => live.has(r.org_id));
    const owners = await ownersOf(
      this.db,
      kept.map((r) => r.org_id),
    );
    return kept.map((r) => ({
      kind,
      id: r.id,
      name: r.name,
      description: r.description,
      plugin: r.plugin,
      itemId: r.catalog_item_id,
      owner: ownerOf(r.org_id, owners),
      shareable: r.shareable,
      promoted: false,
      builtin: false,
      scopeMode: "own" as const,
      scope: "named" as const,
      orgs: [r.org_id],
      disabled: false,
      pluginStopped: false,
      shownToOthers: false,
      version: String(r.current_version),
      onIn: [r.org_id],
      offCount: 0,
    }));
  }

  /** The preview of a scope change, a disable or a return to following the plugin (nothing written). */
  async preview(
    kind: ComponentKind,
    id: string,
    target: ComponentTarget,
  ): Promise<ComponentScopePreview> {
    const r = await this.resolve(kind, id);
    if ("c" in r) {
      const c = await this.component(kind, r.c.id, false);
      return this.compute(c, await this.targetOf(c, target), { hashId: id });
    }
    // an org row not promoted yet (P3-23): as the platform row it would become, `named: [owner]`;
    // a disable is platform-only
    if ("disabled" in target) throw notFound();
    const v = virtualOf(r.org);
    const listed = [r.org.orgId];
    return this.compute(v, await this.targetOf(v, target, listed), { hashId: id, listed });
  }

  /** Gives the component its own scope, or makes it follow its plugin again, after its preview. */
  async setScope(
    actor: string,
    kind: ComponentKind,
    id: string,
    body: ({ scope: PluginScope; orgs?: string[] } | { follow: true }) & { scopeHash: string },
    opts: AuditOpts = {},
  ): Promise<ComponentView> {
    const { scopeHash, ...target } = body;
    const r = await this.resolve(kind, id);
    if ("c" in r) {
      await this.writeScope(actor, kind, r.c.id, target, scopeHash, opts, { hashId: id });
      return this.view(kind, r.c.id);
    }
    // An org row not promoted yet (P3-23): a change that shows it to another org promotes it first
    // (ruling P3-3), after the owner and share gate checks on the org row and the preview's hash
    const v = virtualOf(r.org);
    const listed = [r.org.orgId];
    const t = await this.targetOf(v, target, listed);
    if (t.scopeMode === "own" && t.scope === "named" && t.orgs.join() === listed.join()) {
      return this.view(kind, id);
    }
    assertPromotable(r.org);
    assertOwnerListed(gateRow(v), t);
    assertShareable(gateRow(v));
    const p = await this.compute(v, t, { hashId: id, listed });
    if (p.scopeHash !== scopeHash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts, kind);
    const promotable = kind as "skill" | "agent_template";
    const written = await this.withPromotion(promotable, id, (prepared) =>
      this.writeScope(actor, kind, prepared.platformId, target, scopeHash, opts, {
        hashId: id,
        promote: prepared,
      }),
    );
    return this.view(kind, written);
  }

  /**
   * Disables the component on the whole deployment (after its preview, `scopeHash` required) or
   * enables it again (no hash; refused while an org it would be offered to has a skill of its name).
   */
  async setDisabled(
    actor: string,
    kind: ComponentKind,
    id: string,
    body: { disabled: boolean; scopeHash?: string },
    opts: AuditOpts = {},
  ): Promise<ComponentView> {
    if (body.disabled && body.scopeHash === undefined) {
      throw new ApiError(
        "validation_failed",
        "scopeHash: required when disabling (from POST scope/preview with disabled: true)",
        [{ path: "scopeHash", message: "required when disabling" }],
      );
    }
    await this.writeDisabled(actor, kind, id, body.disabled, body.scopeHash, opts);
    return this.view(kind, id);
  }

  /** Shows or hides the component to orgs outside its `named` list (never makes it usable). */
  async setShown(
    actor: string,
    kind: ComponentKind,
    id: string,
    shown: boolean,
    opts: AuditOpts = {},
  ): Promise<ComponentView> {
    const r = await this.resolve(kind, id);
    if ("c" in r) {
      await this.writeShown(actor, kind, r.c.id, shown, opts);
      return this.view(kind, r.c.id);
    }
    // An org row not promoted yet is shown to nobody: hiding it changes nothing; showing it goes
    // through the share gate on the org row, then promotes it (rulings P3-3, P3-23)
    if (!shown) return this.view(kind, id);
    assertPromotable(r.org);
    assertShareable(gateRow(virtualOf(r.org)));
    const written = await this.withPromotion(kind as "skill" | "agent_template", id, (prepared) =>
      this.writeShown(actor, kind, prepared.platformId, true, opts, prepared),
    );
    return this.view(kind, written);
  }

  /**
   * The org admin's switch of one component (`PUT orgs/:orgId/components/:kind/:id/switch`): only
   * this component (rule 5). A component not offered to the org -> 404. On: refused while the
   * component or its plugin is disabled (`plugin.disabled`) or an own skill of the org has its name
   * (`plugin.skill_conflict`, rule 10; a theme: `theme.id_taken`). Off: the platform default theme
   * while it is on -> `theme.platform_default`; of a builtin plugin -> `plugin.scope_locked`; while it
   * is on, without `confirm` the preview (agents that use it) and its hash are returned, with the
   * current hash the switch is written (a changed preview -> `plugin.switch_stale`).
   */
  @Transactional()
  async setSwitch(
    orgId: string,
    actor: string,
    kind: ComponentKind,
    id: string,
    body: { enabled: boolean; confirm?: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<ComponentSwitchResult> {
    await this.orgLock.lockAndAuthorize(orgId, actor, ACTION[kind]);
    // The rows an unshare narrows (ruling P3-25) are locked before the scope is read, in its order
    // (plugin, then component): a switch-on never commits against a scope narrowed meanwhile
    const [found] = await loadComponents(this.db, kind, { ids: [id] });
    if (!found) throw notFound();
    if (found.itemId !== null) await lockItemShared(this.db, found.itemId);
    const [c] = await loadComponents(this.db, kind, { ids: [id], forUpdate: true });
    if (!c) throw notFound();
    const st = await loadScopeState(this.db, kind, [c]);
    const p = pluginFactsOf(st, c.itemId, orgId);
    const listed = listedIn(st, c.id, orgId);
    const sw = switchOf(st, c.id, orgId);
    const on = componentOn(c, p, listed, sw);
    // Disabled on the deployment (the component or its plugin): it keeps its scope, so the org's
    // switch can still be turned off, never on; one its scope does not offer the org is unknown
    const stopped = c.disabled || (p?.live === true && p.disabled);
    const offered = componentOffered(
      { ...c, disabled: false },
      p && { ...p, disabled: false },
      listed,
    );
    if (!on && !offered) throw notFound();
    if (body.enabled && stopped) {
      throw new ApiError(
        "plugin.disabled",
        "This component is disabled by the super admin and cannot be switched on",
      );
    }
    if (body.enabled) {
      if (kind === "theme") {
        // theme ids are unique among the themes on in the org (themes spec §6)
        if (!on && componentOn(c, p, listed, true)) {
          const clash = await themeIdClashes(this.db, orgId, c, c.name);
          if (clash.length > 0) {
            const [org] = await this.liveOrgs(orgId);
            throw nameConflictError(
              [
                {
                  orgId,
                  orgName: org?.name ?? orgId,
                  name: c.name,
                  skills: [],
                  themes: clash.map((x) => x.id),
                  plugins: clash.map((x) => x.plugin ?? "platform"),
                },
              ],
              kind,
            );
          }
        }
      } else if (kind !== "connector_template" && !on) {
        const clash =
          kind === "skill"
            ? await skillNameClashes(this.db, orgId, c, c.name)
            : await templateTypeClashes(this.db, orgId, c);
        if (clash.skills.length > 0) {
          const [org] = await this.liveOrgs(orgId);
          const name = kind === "skill" ? c.name : templateTypeOf(c.plugin, c.name);
          throw nameConflictError([{ orgId, orgName: org?.name ?? orgId, name, ...clash }], kind);
        }
      }
    } else {
      // The platform default theme is locked on in every org (themes spec §7): refused before the
      // preview, inside this transaction
      if (kind === "theme" && on) await assertNotPlatformDefault(this.db, [c.id], () => "narrower");
      if (componentLocked(c, p)) {
        throw new ApiError(
          "plugin.scope_locked",
          "This component belongs to a built-in plugin: it is on for every organization and cannot be switched off here",
        );
      }
      if (on) {
        const themes =
          kind === "theme"
            ? await themesPreview(this.db, new Map([[c.id, new Set([orgId])]]))
            : undefined;
        const preview = {
          agents: await agentsUsing(this.db, orgId, kind, [c.id]),
          connectorsKept:
            kind === "connector_template" ? await connectorsMadeFrom(this.db, orgId, c.id) : 0,
          // a theme only: other kinds keep the preview (and the hash) they had before themes
          ...(themes !== undefined && { themes }),
        };
        const confirm = switchHash(orgId, c, preview);
        if (body.confirm === undefined) return { kind: "preview", preview, confirm };
        if (body.confirm !== confirm) {
          throw new ApiError(
            "plugin.switch_stale",
            "What switching this component off affects has changed; review it and confirm again",
          );
        }
      }
    }
    if (sw !== body.enabled) {
      await this.db
        .insertInto("component_org_switches")
        .values({
          kind,
          component_id: c.id,
          org_id: orgId,
          enabled: body.enabled,
          updated_by: actor,
        })
        .onConflict((oc) =>
          oc.columns(["kind", "component_id", "org_id"]).doUpdateSet({
            enabled: body.enabled,
            updated_by: actor,
            updated_at: sql<Date>`now()` as unknown as Date,
          }),
        )
        .execute();
      await audit(this.db, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "component.org_switched",
        target: c.id,
        detail: {
          kind,
          name: c.name,
          plugin: c.plugin,
          from: sw,
          to: body.enabled,
          ...auditDetail,
        },
      });
    }
    return {
      kind: "done",
      component: {
        kind,
        id: c.id,
        name: c.name,
        plugin: c.plugin,
        switch: body.enabled,
        on: componentOn(c, p, listed, body.enabled),
        locked: componentLocked(c, p) || isUiTheme(c, await platformDefaultThemeId(this.db)),
      },
    };
  }

  /**
   * What {@link setSwitch} would do to the org's switch, read-only (the Platform tool's preview):
   * the component as the org sees it, whether it is `stopped` on the deployment, and for one that
   * is on and can be switched off the preview of the agents that lose it with the `confirm` hash
   * the switch-off needs (both null otherwise). Unknown or not offered -> 404 `component.not_found`.
   */
  async switchPreview(
    orgId: string,
    kind: ComponentKind,
    id: string,
  ): Promise<{
    component: OrgComponentView;
    stopped: boolean;
    preview: {
      agents: { id: string; name: string; refs: string[] }[];
      connectorsKept: number;
    } | null;
    confirm: string | null;
  }> {
    const [c] = await loadComponents(this.db, kind, { ids: [id] });
    if (!c) throw notFound();
    const st = await loadScopeState(this.db, kind, [c]);
    const p = pluginFactsOf(st, c.itemId, orgId);
    const listed = listedIn(st, c.id, orgId);
    const sw = switchOf(st, c.id, orgId);
    const on = componentOn(c, p, listed, sw);
    const stopped = c.disabled || (p?.live === true && p.disabled);
    const offered = componentOffered(
      { ...c, disabled: false },
      p && { ...p, disabled: false },
      listed,
    );
    if (!on && !offered) throw notFound();
    const locked = componentLocked(c, p) || isUiTheme(c, await platformDefaultThemeId(this.db));
    let preview = null;
    let confirm = null;
    if (on && !locked) {
      preview = {
        agents: await agentsUsing(this.db, orgId, kind, [c.id]),
        connectorsKept:
          kind === "connector_template" ? await connectorsMadeFrom(this.db, orgId, c.id) : 0,
      };
      confirm = switchHash(orgId, c, preview);
    }
    return {
      component: { kind, id: c.id, name: c.name, plugin: c.plugin, switch: sw, on, locked },
      stopped,
      preview,
      confirm,
    };
  }

  /**
   * `x.hashId`: the id the preview was asked for (an org row's id before its promotion);
   * `x.promote`: the org row to promote first, in this transaction. Returns the id written.
   */
  @Transactional()
  private async writeScope(
    actor: string,
    kind: ComponentKind,
    id: string,
    target: { scope: PluginScope; orgs?: string[] } | { follow: true },
    hash: string,
    opts: AuditOpts,
    x: { hashId: string; promote?: PreparedPromotion },
  ): Promise<string> {
    await this.adminLock.lockAndAuthorize(actor);
    if (x.promote) id = await this.promotion.promote(x.promote, actor);
    const c = await this.component(kind, id, true);
    const t = await this.targetOf(c, target);
    if (kind === "theme") await this.assertKeepsPlatformDefault(c, t);
    const from = await this.listed(kind, id);
    // Its own scope: the owner stays listed (P3-17), widening goes through the share gate (P3-16);
    // following the plugin again takes the plugin's scope, which its own writer gates
    if (t.scopeMode === "own") {
      assertOwnerListed(gateRow(c), t);
      assertShareableTarget(gateRow(c), await this.effectiveScope(c, from), t);
    }
    const p = await this.compute(c, t, { hashId: x.hashId });
    if (p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts, kind);
    if (c.scopeMode === t.scopeMode && c.scope === t.scope && from.join() === t.orgs.join()) {
      return id;
    }
    const before = await this.effectiveScope(c, from);
    await this.db
      .updateTable(TABLE[kind] as "platform_skills")
      .set({
        scope_mode: t.scopeMode,
        scope: t.scope,
        scope_version: sql<number>`scope_version + 1`,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("id", "=", id)
      .execute();
    await this.db
      .deleteFrom("component_scope_orgs")
      .where("kind", "=", kind)
      .where("component_id", "=", id)
      .execute();
    if (t.scopeMode === "own" && t.orgs.length > 0) {
      await this.db
        .insertInto("component_scope_orgs")
        .values(t.orgs.map((org_id) => ({ kind, component_id: id, org_id })))
        .execute();
    }
    // An own scope that newly shows an org-owned component tells its owner (P3-22); not a theme:
    // the `item_shared` notice names plugins, skills and agent templates only
    if (t.scopeMode === "own" && kind !== "connector_template" && kind !== "theme") {
      const shared = newlySharedWith(before, t);
      if (shared === "all_orgs" || shared.length > 0) {
        await notifyItemShared(this.db, c.ownerOrgId, { kind, id }, c.name, shared);
      }
    }
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "component.scope_changed",
      target: id,
      detail: {
        kind,
        name: c.name,
        plugin: c.plugin,
        from: { scopeMode: c.scopeMode, scope: c.scope, orgs: from },
        to: { scopeMode: t.scopeMode, scope: t.scope, orgs: t.orgs },
        ...opts.auditDetail,
      },
    });
    return id;
  }

  @Transactional()
  private async writeDisabled(
    actor: string,
    kind: ComponentKind,
    id: string,
    disabled: boolean,
    hash: string | undefined,
    opts: AuditOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const c = await this.component(kind, id, true);
    if (c.disabled === disabled) return;
    const t = await this.targetOf(c, { disabled });
    if (kind === "theme") await this.assertKeepsPlatformDefault(c, t);
    const p = await this.compute(c, t);
    if (disabled && p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts, kind);
    await this.db
      .updateTable(TABLE[kind] as "platform_skills")
      .set({
        disabled,
        scope_version: sql<number>`scope_version + 1`,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("id", "=", id)
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "component.scope_changed",
      target: id,
      detail: {
        kind,
        name: c.name,
        plugin: c.plugin,
        disabled: { from: c.disabled, to: disabled },
        ...opts.auditDetail,
      },
    });
  }

  /** `promote`: the org row to promote first, in this transaction. Returns the id written. */
  @Transactional()
  private async writeShown(
    actor: string,
    kind: ComponentKind,
    id: string,
    shown: boolean,
    opts: AuditOpts,
    promote?: PreparedPromotion,
  ): Promise<string> {
    await this.adminLock.lockAndAuthorize(actor);
    if (promote) id = await this.promotion.promote(promote, actor);
    const [c] = await loadComponents(this.db, kind, { ids: [id], forUpdate: true });
    if (!c) throw notFound();
    // Showing goes through the share gate (P3-16); hiding is always allowed
    if (shown) assertShareable(gateRow(c));
    if (c.shownToOthers === shown) return id;
    await this.db
      .updateTable(TABLE[kind] as "platform_skills")
      .set({ shown_to_others: shown, updated_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", id)
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "component.shown_changed",
      target: id,
      detail: {
        kind,
        name: c.name,
        plugin: c.plugin,
        from: c.shownToOthers,
        to: shown,
        ...opts.auditDetail,
      },
    });
    return id;
  }

  /**
   * A live component's versions, newest first. A connector template keeps no history: its one entry
   * is the current version. Missing (or removed) -> 404 `component.not_found`.
   */
  async versions(kind: ComponentKind, id: string): Promise<ComponentVersionView[]> {
    const r = await this.resolve(kind, id);
    if ("org" in r) return this.orgOwnedVersions(kind, id);
    const c = r.c;
    id = c.id;
    if (kind === "connector_template") {
      const row = await this.db
        .selectFrom("platform_connector_templates")
        .select("updated_at")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return [
        {
          version: c.version,
          catalogVersion: c.version,
          updatedOnOwn: false,
          createdAt: row.updated_at.toISOString(),
        },
      ];
    }
    const rows =
      kind === "skill"
        ? await this.db
            .selectFrom("platform_skill_versions")
            .select(["version", "catalog_version", "updated_on_own", "created_at"])
            .where("skill_id", "=", id)
            .orderBy("version", "desc")
            .execute()
        : kind === "theme"
          ? await this.db
              .selectFrom("platform_theme_versions")
              .select(["version", "catalog_version", "updated_on_own", "created_at"])
              .where("theme_id", "=", id)
              .orderBy("version", "desc")
              .execute()
          : await this.db
              .selectFrom("platform_agent_template_versions")
              .select(["version", "catalog_version", "updated_on_own", "created_at"])
              .where("template_id", "=", id)
              .orderBy("version", "desc")
              .execute();
    return rows.map((r) => ({
      version: String(r.version),
      catalogVersion: r.catalog_version,
      updatedOnOwn: r.updated_on_own,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** An org-owned skill's or agent template's versions (ruling P2-11); else 404. */
  private async orgOwnedVersions(kind: ComponentKind, id: string): Promise<ComponentVersionView[]> {
    const owned = (await this.list(kind)).find((x) => x.id === id && x.owner.kind === "org");
    if (!owned) throw notFound();
    const rows =
      kind === "skill"
        ? await this.db
            .selectFrom("skill_versions")
            .select(["version", "catalog_version", "created_at"])
            .where("skill_id", "=", id)
            .orderBy("version", "desc")
            .execute()
        : await this.db
            .selectFrom("agent_template_versions")
            .select(["version", "catalog_version", "created_at"])
            .where("template_id", "=", id)
            .orderBy("version", "desc")
            .execute();
    return rows.map((r) => ({
      version: String(r.version),
      catalogVersion: r.catalog_version,
      updatedOnOwn: false,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async view(kind: ComponentKind, id: string): Promise<ComponentView> {
    const v = (await this.list(kind)).find((x) => x.id === id);
    if (!v) throw notFound();
    return v;
  }

  /** The live component (row locked with `forUpdate`); missing -> 404, of a builtin plugin -> 409. */
  private async component(
    kind: ComponentKind,
    id: string,
    forUpdate: boolean,
  ): Promise<ComponentRow> {
    const [c] = await loadComponents(this.db, kind, { ids: [id], forUpdate });
    if (!c) throw notFound();
    if (c.itemId !== null) {
      const item = await this.db
        .selectFrom("catalog_items")
        .select("builtin")
        .where("id", "=", c.itemId)
        .executeTakeFirst();
      if (item?.builtin) throw builtinError();
    }
    return c;
  }

  /**
   * The scope that offers the component now: its own (`listed`: its own list), or for `follow` its
   * plugin's (`all` for a builtin or deleted plugin: the widest, so nothing counts as widening).
   */
  private async effectiveScope(
    c: ComponentRow,
    listed: string[],
  ): Promise<{ scope: PluginScope; orgs: string[] }> {
    if (c.scopeMode === "own" || c.itemId === null) return { scope: c.scope, orgs: listed };
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["scope", "builtin"])
      .where("id", "=", c.itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item || item.builtin) return { scope: "all", orgs: [] };
    const rows = await this.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", c.itemId)
      .execute();
    return { scope: item.scope, orgs: rows.map((r) => r.org_id) };
  }

  /** The component's own `named` list, sorted. */
  private async listed(kind: ComponentKind, id: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("component_scope_orgs")
      .select("org_id")
      .where("kind", "=", kind)
      .where("component_id", "=", id)
      .orderBy("org_id")
      .execute();
    return rows.map((r) => r.org_id);
  }

  /**
   * The state after the change: `orgs` only with `named`, each a live org. `listed`: the list now
   * (an org row not promoted yet: `[owner]`), else read.
   */
  private async targetOf(
    c: ComponentRow,
    target: ComponentTarget,
    listed?: string[],
  ): Promise<Target> {
    const now = {
      scopeMode: c.scopeMode,
      scope: c.scope,
      orgs: listed ?? (await this.listed(c.kind, c.id)),
      disabled: c.disabled,
    };
    if ("disabled" in target) return { ...now, disabled: target.disabled };
    if ("follow" in target) {
      if (c.itemId === null) {
        throw new ApiError("validation_failed", "follow: this component has no plugin to follow", [
          { path: "follow", message: "the component has no plugin" },
        ]);
      }
      return { ...now, scopeMode: "follow", orgs: [] };
    }
    if (target.orgs !== undefined && target.scope !== "named") {
      throw new ApiError("validation_failed", "orgs: only allowed with scope named", [
        { path: "orgs", message: "only allowed with scope named" },
      ]);
    }
    const orgs = [...new Set(target.orgs ?? [])].sort();
    await assertOrgsExist(this.db, orgs);
    return { scopeMode: "own", scope: target.scope, orgs, disabled: c.disabled };
  }

  /**
   * 409 `theme.platform_default` when theme `c` is the platform default and `t` would leave it
   * narrower than `all` or gone (themes spec §7), in the caller's transaction, before any write.
   */
  private async assertKeepsPlatformDefault(c: ComponentRow, t: Target): Promise<void> {
    const after = await this.themeAfter(c, t);
    await assertNotPlatformDefault(this.db, [c.id], () => after);
  }

  /**
   * Theme `c`'s availability under `t`: gone when disabled (or its plugin is disabled or deleted
   * while it follows it), else `all` when its effective scope (its own, or its plugin's; builtin:
   * `all`) is `all`, else narrower.
   */
  private async themeAfter(c: ComponentRow, t: Target): Promise<ThemeAfter> {
    if (t.disabled) return "gone";
    if (t.scopeMode === "own") return t.scope === "all" ? "all" : "narrower";
    if (c.itemId === null) return "gone";
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["scope", "builtin", "disabled"])
      .where("id", "=", c.itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item || item.disabled) return "gone";
    return item.builtin || item.scope === "all" ? "all" : "narrower";
  }

  /** Live orgs (`only`: that one), sorted by id. */
  private async liveOrgs(only?: string): Promise<{ id: string; name: string }[]> {
    let q = this.db
      .selectFrom("orgs")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .orderBy("id");
    if (only !== undefined) q = q.where("id", "=", only);
    return q.execute();
  }

  private on(c: ComponentRow, st: ScopeState, orgId: string): boolean {
    return componentOn(
      c,
      pluginFactsOf(st, c.itemId, orgId),
      listedIn(st, c.id, orgId),
      switchOf(st, c.id, orgId),
    );
  }

  /**
   * The preview of moving `c` to `target` (read through the current context). `x.hashId`: the id
   * the hash names (the one the preview was asked for); `x.listed`: the list now of an org row not
   * promoted yet (`[owner]`).
   */
  private async compute(
    c: ComponentRow,
    target: Target,
    x: { hashId?: string; listed?: string[] } = {},
  ): Promise<ComponentScopePreview> {
    const st = await loadScopeState(this.db, c.kind, [c]);
    if (x.listed !== undefined) st.listed.set(c.id, new Set(x.listed));
    const after: ComponentScopeFacts = {
      scopeMode: target.scopeMode,
      scope: target.scope,
      disabled: target.disabled,
      itemId: c.itemId,
      // a template shipped off stays so: following its plugin again, it is off without a switch
      ...(c.defaultOff === true && { defaultOff: true }),
    };
    const listedAfter = new Set(target.orgs);
    const affected: ComponentScopePreview["affected"] = [];
    const conflicts: ComponentScopePreview["conflicts"] = [];
    /** A theme: the orgs it is on in now and would be off in. */
    const lost = new Set<string>();
    for (const org of await this.liveOrgs()) {
      const p: PluginFacts | null = pluginFactsOf(st, c.itemId, org.id);
      const listed = listedIn(st, c.id, org.id);
      const sw = switchOf(st, c.id, org.id);
      const onNow = componentOn(c, p, listed, sw);
      const onAfter = componentOn(after, p, listedAfter.has(org.id), sw);
      if (onNow && !onAfter) {
        lost.add(org.id);
        const agents = await agentsUsing(this.db, org.id, c.kind, [c.id]);
        affected.push({
          orgId: org.id,
          orgName: org.name,
          agents: agents.map((a) => ({ id: a.id, name: a.name })),
          connectorsKept:
            c.kind === "connector_template" ? await connectorsMadeFrom(this.db, org.id, c.id) : 0,
        });
      }
      if (c.kind === "theme") {
        // theme ids are unique among the themes on in an org (themes spec §6)
        if (onAfter && !onNow) {
          const clash = await themeIdClashes(this.db, org.id, c, c.name);
          if (clash.length > 0) {
            conflicts.push({
              orgId: org.id,
              orgName: org.name,
              name: c.name,
              skills: [],
              themes: clash.map((x) => x.id),
              plugins: clash.map((x) => x.plugin ?? "platform"),
            });
          }
        }
        continue;
      }
      if (
        c.kind !== "connector_template" &&
        componentOffered(after, p, listedAfter.has(org.id)) &&
        !componentOffered(c, p, listed)
      ) {
        // rule 10: a skill by its name, an agent template by its roster type (ruling P4-13)
        const clash =
          c.kind === "skill"
            ? await skillNameClashes(this.db, org.id, c, c.name)
            : await templateTypeClashes(this.db, org.id, c);
        if (clash.skills.length > 0) {
          const name = c.kind === "skill" ? c.name : templateTypeOf(c.plugin, c.name);
          conflicts.push({ orgId: org.id, orgName: org.name, name, ...clash });
        }
      }
    }
    const themes =
      c.kind === "theme" ? await themesPreview(this.db, new Map([[c.id, lost]])) : undefined;
    const p = { affected, conflicts, ...(themes !== undefined && { themes }) };
    return { ...p, scopeHash: previewHash({ kind: c.kind, id: x.hashId ?? c.id }, target, p) };
  }
}

/** Whether `c` is the platform default theme `uiTheme` (locked on in every org, themes spec §7). */
const isUiTheme = (c: { kind: ComponentKind; id: string }, uiTheme: string | null): boolean =>
  c.kind === "theme" && c.id === uiTheme;

/** The plugin row FOR SHARE (exclusive with its scope writers and an unshare, which hold it FOR UPDATE). */
async function lockItemShared(db: KernelSchemaDb, itemId: string): Promise<void> {
  await db.selectFrom("catalog_items").select("id").where("id", "=", itemId).forShare().execute();
}

/**
 * An org row not promoted yet as the platform row it would become (ruling P3-3): its own scope
 * `named: [owner]`, not shown, owned and created by its org.
 */
const virtualOf = (o: OrgRow): ComponentRow => ({
  kind: o.kind,
  id: o.id,
  name: o.name,
  plugin: o.plugin,
  version: String(o.version),
  description: null,
  itemId: null,
  scopeMode: "own",
  scope: "named",
  disabled: false,
  shownToOthers: false,
  ownerOrgId: o.orgId,
  originOrgId: o.orgId,
  shareable: o.shareable,
});

/**
 * 409 `catalog.not_owned` unless the org row is content its org created itself (ruling P3-46): a
 * skill without plugin provenance, an org template (no plugin, no catalog item; ruling P4-13).
 */
function assertPromotable(o: OrgRow): void {
  if (!o.ownable) throw notOwnedError(o.name);
}

/** The share gate's view of a component row. */
const gateRow = (c: ComponentRow) => ({
  owner_org_id: c.ownerOrgId,
  shareable: c.shareable,
  name: c.name,
});

const TABLE: Record<ComponentKind, string> = {
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
  connector_template: "platform_connector_templates",
  theme: "platform_themes",
};
