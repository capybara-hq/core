import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import type { OrgAction } from "../orgs/roles.js";
import type { ActorOpts } from "./catalog.service.js";
import { assertOrgsExist } from "./catalog-items.js";
import {
  agentsUsing,
  type ComponentKind,
  type ComponentRow,
  type ComponentScopeFacts,
  componentLocked,
  componentOffered,
  componentOn,
  connectorsMadeFrom,
  listedIn,
  loadComponents,
  loadScopeState,
  type PluginFacts,
  pluginFactsOf,
  type ScopeState,
  skillNameClashes,
  switchOf,
} from "./component-state.js";
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
  /** `skills`: the clashing skill ids (org skills, other platform skills); `plugins`: theirs. */
  conflicts: {
    orgId: string;
    orgName: string;
    name: string;
    skills: string[];
    plugins: string[];
  }[];
  scopeHash: string;
}

/** A component's own scope (`orgs` only with `named`), a disable, or following its plugin again. */
export type ComponentTarget =
  | { scope: PluginScope; orgs?: string[] }
  | { disabled: boolean }
  | { follow: true };

/** A platform component in the admin list (`GET admin/components`). */
export interface ComponentView {
  kind: ComponentKind;
  id: string;
  name: string;
  description: string | null;
  /** The plugin it came from (null: none). */
  plugin: string | null;
  itemId: string | null;
  owner: "platform";
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
  /** Its effective scope is `all`: it cannot be switched off. */
  locked: boolean;
}

/** The result of an org switch: the component, or (switching off without `confirm`) the preview. */
export type ComponentSwitchResult =
  | { kind: "done"; component: OrgComponentView }
  | {
      kind: "preview";
      preview: { agents: { id: string; name: string; refs: string[] }[]; connectorsKept: number };
      confirm: string;
    };

interface Target {
  scopeMode: "follow" | "own";
  scope: PluginScope;
  orgs: string[];
  disabled: boolean;
}

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
};

/** 409 `plugin.skill_conflict` listing the orgs whose own skills use a component's name (rule 10). */
export function nameConflictError(conflicts: ComponentScopePreview["conflicts"]): ApiError {
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
      }),
    )
    .digest("hex");
}

/** The confirm hash of an org switch-off preview. */
function switchHash(
  orgId: string,
  c: { kind: ComponentKind; id: string },
  preview: { agents: { id: string; refs: string[] }[]; connectorsKept: number },
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
 * An org admin switches one component on or off in the org (only that component, rule 5); `all` ->
 * 409 `plugin.scope_locked`; switching off something in use is previewed with its agents first.
 * Name clashes are checked for skills only: an org agent template always carries its plugin's
 * type, so one with a platform template's type is a copy of it. Components are resolved at read
 * time (skills/usable.ts, agents/templates.ts), so nothing is enqueued. Stateless, shared by every
 * replica.
 */
@Injectable()
export class ComponentScopeService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The platform components of `kind`, with their effective scope and the orgs they are on in. */
  async list(kind: ComponentKind): Promise<ComponentView[]> {
    const comps = await loadComponents(this.db, kind);
    const st = await loadScopeState(this.db, kind, comps);
    const orgs = await this.liveOrgs();
    return comps
      .map((c) => {
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
          owner: "platform" as const,
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
        };
      })
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
  }

  /** The preview of a scope change, a disable or a return to following the plugin (nothing written). */
  async preview(
    kind: ComponentKind,
    id: string,
    target: ComponentTarget,
  ): Promise<ComponentScopePreview> {
    const c = await this.component(kind, id, false);
    return this.compute(c, await this.targetOf(c, target));
  }

  /** Gives the component its own scope, or makes it follow its plugin again, after its preview. */
  async setScope(
    actor: string,
    kind: ComponentKind,
    id: string,
    body: ({ scope: PluginScope; orgs?: string[] } | { follow: true }) & { scopeHash: string },
    opts: ActorOpts = {},
  ): Promise<ComponentView> {
    const { scopeHash, ...target } = body;
    await this.writeScope(actor, kind, id, target, scopeHash, opts);
    return this.view(kind, id);
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
    opts: ActorOpts = {},
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
    opts: ActorOpts = {},
  ): Promise<ComponentView> {
    await this.writeShown(actor, kind, id, shown, opts);
    return this.view(kind, id);
  }

  /**
   * The org admin's switch of one component (`PUT orgs/:orgId/components/:kind/:id/switch`): only
   * this component (rule 5). A component not offered to the org -> 404. On: refused while the
   * component or its plugin is disabled (`plugin.disabled`) or an own skill of the org has its name
   * (`plugin.skill_conflict`, rule 10). Off: `all` -> `plugin.scope_locked`; while it is on, without
   * `confirm` the preview (agents that use it) and its hash are returned, with the current hash the
   * switch is written (a changed preview -> `plugin.switch_stale`).
   */
  @Transactional()
  async setSwitch(
    orgId: string,
    actor: string,
    kind: ComponentKind,
    id: string,
    body: { enabled: boolean; confirm?: string },
    actorTokenId?: string,
  ): Promise<ComponentSwitchResult> {
    await this.orgLock.lockAndAuthorize(orgId, actor, ACTION[kind]);
    const [c] = await loadComponents(this.db, kind, { ids: [id] });
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
      if (kind === "skill" && !on) {
        const clash = await skillNameClashes(this.db, orgId, c, c.name);
        if (clash.skills.length > 0) {
          const [org] = await this.liveOrgs(orgId);
          throw nameConflictError([{ orgId, orgName: org?.name ?? orgId, name: c.name, ...clash }]);
        }
      }
    } else {
      if (componentLocked(c, p)) {
        throw new ApiError(
          "plugin.scope_locked",
          "This component is on for every organization and cannot be switched off here",
        );
      }
      if (on) {
        const preview = {
          agents: await agentsUsing(this.db, orgId, kind, [c.id]),
          connectorsKept:
            kind === "connector_template" ? await connectorsMadeFrom(this.db, orgId, c.id) : 0,
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
        detail: { kind, name: c.name, plugin: c.plugin, from: sw, to: body.enabled },
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
        locked: componentLocked(c, p),
      },
    };
  }

  @Transactional()
  private async writeScope(
    actor: string,
    kind: ComponentKind,
    id: string,
    target: { scope: PluginScope; orgs?: string[] } | { follow: true },
    hash: string,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const c = await this.component(kind, id, true);
    const t = await this.targetOf(c, target);
    const p = await this.compute(c, t);
    if (p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts);
    const from = await this.listed(kind, id);
    if (c.scopeMode === t.scopeMode && c.scope === t.scope && from.join() === t.orgs.join()) return;
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
      },
    });
  }

  @Transactional()
  private async writeDisabled(
    actor: string,
    kind: ComponentKind,
    id: string,
    disabled: boolean,
    hash: string | undefined,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const c = await this.component(kind, id, true);
    if (c.disabled === disabled) return;
    const p = await this.compute(c, await this.targetOf(c, { disabled }));
    if (disabled && p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts);
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
      },
    });
  }

  @Transactional()
  private async writeShown(
    actor: string,
    kind: ComponentKind,
    id: string,
    shown: boolean,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const [c] = await loadComponents(this.db, kind, { ids: [id], forUpdate: true });
    if (!c) throw notFound();
    if (c.shownToOthers === shown) return;
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
      detail: { kind, name: c.name, plugin: c.plugin, from: c.shownToOthers, to: shown },
    });
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

  /** The state after the change: `orgs` only with `named`, each a live org. */
  private async targetOf(c: ComponentRow, target: ComponentTarget): Promise<Target> {
    const now = {
      scopeMode: c.scopeMode,
      scope: c.scope,
      orgs: await this.listed(c.kind, c.id),
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

  /** The preview of moving `c` to `target` (read through the current context). */
  private async compute(c: ComponentRow, target: Target): Promise<ComponentScopePreview> {
    const st = await loadScopeState(this.db, c.kind, [c]);
    const after: ComponentScopeFacts = {
      scopeMode: target.scopeMode,
      scope: target.scope,
      disabled: target.disabled,
      itemId: c.itemId,
    };
    const listedAfter = new Set(target.orgs);
    const affected: ComponentScopePreview["affected"] = [];
    const conflicts: ComponentScopePreview["conflicts"] = [];
    for (const org of await this.liveOrgs()) {
      const p: PluginFacts | null = pluginFactsOf(st, c.itemId, org.id);
      const listed = listedIn(st, c.id, org.id);
      const sw = switchOf(st, c.id, org.id);
      if (componentOn(c, p, listed, sw) && !componentOn(after, p, listedAfter.has(org.id), sw)) {
        const agents = await agentsUsing(this.db, org.id, c.kind, [c.id]);
        affected.push({
          orgId: org.id,
          orgName: org.name,
          agents: agents.map((a) => ({ id: a.id, name: a.name })),
          connectorsKept:
            c.kind === "connector_template" ? await connectorsMadeFrom(this.db, org.id, c.id) : 0,
        });
      }
      if (
        c.kind === "skill" &&
        componentOffered(after, p, listedAfter.has(org.id)) &&
        !componentOffered(c, p, listed)
      ) {
        const clash = await skillNameClashes(this.db, org.id, c, c.name);
        if (clash.skills.length > 0) {
          conflicts.push({ orgId: org.id, orgName: org.name, name: c.name, ...clash });
        }
      }
    }
    const p = { affected, conflicts };
    return { ...p, scopeHash: previewHash(c, target, p) };
  }
}

const TABLE: Record<ComponentKind, string> = {
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
  connector_template: "platform_connector_templates",
};
