import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  ComponentDisabledSchema,
  ComponentParams,
  ComponentScopeFields,
  ComponentScopePreviewFields,
  ComponentShownSchema,
  ComponentTemplateVersionSchema,
  componentScopeRules,
} from "../../catalog/component-scope.schemas.js";
import {
  type ComponentScopePreview,
  ComponentScopeService,
  type ComponentTarget,
  type ComponentView,
  type OrgOfferedComponentView,
} from "../../catalog/component-scope.service.js";
import type { ComponentKind } from "../../catalog/component-state.js";
import { PlatformComponents } from "../../catalog/platform-components.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named, orElse } from "./summary.js";

/** Entries per page of the paged lists (the tool caps a bare list at 50). */
const PAGE = 50;
/** The confirm value of switching off a component that is not on in the org. */
const ALREADY_OFF = "already-off";
const EXAMPLE_ID = "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c";

const Id = ComponentParams.shape.id;
const Confirm = z.string().min(1).max(64);

/** What each kind is called in card summaries, and the message of each switch refusal. */
const LABEL: Record<ComponentKind, { en: string; zh: string }> = {
  skill: { en: "platform skill", zh: "平台技能" },
  agent_template: { en: "platform agent template", zh: "平台智能体模板" },
  connector_template: { en: "platform connector template", zh: "平台连接器模板" },
};
const REFUSED: Record<string, string> = {
  "plugin.disabled": "This component is disabled by the super admin and cannot be switched on",
  "plugin.scope_locked":
    "This component belongs to a built-in plugin: it cannot be switched off in one org",
  "plugin.switch_stale":
    "What switching this component off affects has changed, or the confirm value is not the preview's",
};

const OTHER_ORG_COMPONENT =
  "This component belongs to another org; its owner manages it, and the admin console shows it.";

/** The refusal text of a name clash when the clashing orgs cannot be read again. */
const CLASH = "Other orgs already use this component's name, so the change is refused.";

/**
 * The refusal text of a name clash, one part per org: the org is named (platform data, spec
 * §14.5 item 1), the clashing skills, templates and plugins are counted, never named (they may be
 * that org's own).
 */
const clashText = (cs: ComponentScopePreview["conflicts"]): string =>
  cs.length === 0
    ? CLASH
    : `The change would offer a name twice, so it is refused: ${cs
        .map(
          (c) =>
            `"${c.name}" is already used in org ${c.orgName} (${c.skills.length} item(s), ${c.plugins.length} plugin(s))`,
        )
        .join("; ")}`;

const stateOf = (c: ComponentView) => (c.disabled || c.pluginStopped ? "disabled" : "on");

type OrgRef = { orgId: string; orgName: string };

/**
 * A platform component as the super admin's writes return it: the orgs it is on in and the orgs
 * its named scope lists are named (admin data in full, spec §14.5.1; another org's own component
 * never gets here, see `assertNotOtherOrgs`).
 */
const brief = (c: ComponentView, names: ReadonlyMap<string, string>) => {
  const ref = (orgId: string): OrgRef => ({ orgId, orgName: names.get(orgId) ?? orgId });
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    state: stateOf(c),
    plugin: c.plugin,
    scope: c.scope,
    scopeMode: c.scopeMode,
    ...(c.scope === "named" && { scopeOrgs: c.orgs.map(ref) }),
    shownToOthers: c.shownToOthers,
    version: c.version,
    onIn: c.onIn.map(ref),
  };
};

/** The scope as card summaries say it. */
const scopeText = (t: { scope?: string | undefined; orgs?: readonly string[] | undefined }) =>
  t.scope === undefined
    ? { zh: "跟随所属插件的范围", en: "follow its plugin's scope" }
    : t.scope === "named"
      ? {
          zh: `指定组织（${t.orgs?.length ?? 0} 个）`,
          en: `named (${t.orgs?.length ?? 0} orgs)`,
        }
      : t.scope === "all"
        ? { zh: "所有组织", en: "all orgs" }
        : { zh: "可选", en: "optional" };

type ScopeInput = {
  scope?: "all" | "optional" | "named" | undefined;
  orgs?: string[] | undefined;
  disabled?: true | undefined;
};
const previewTarget = (i: ScopeInput): ComponentTarget =>
  i.scope !== undefined
    ? { scope: i.scope, ...(i.orgs !== undefined && { orgs: i.orgs }) }
    : i.disabled === true
      ? { disabled: true }
      : { follow: true };
const scopeTarget = (i: ScopeInput): ComponentTarget =>
  i.scope !== undefined
    ? { scope: i.scope, ...(i.orgs !== undefined && { orgs: i.orgs }) }
    : { follow: true };
const scopeBody = (i: ScopeInput & { scopeHash: string }) =>
  i.scope !== undefined
    ? {
        scope: i.scope,
        scopeHash: i.scopeHash,
        ...(i.orgs !== undefined && { orgs: i.orgs }),
      }
    : { follow: true as const, scopeHash: i.scopeHash };

/** A platform component as the `available` lists show it: a compact row. */
function row(c: OrgOfferedComponentView) {
  return {
    id: c.id,
    name: c.name,
    state: c.on ? "on" : "off",
    ...(!c.on &&
      !c.pluginOn && {
        reason: "Its plugin is off in the org.",
        next: "Switch its plugin on first (plugins.set-enabled, org admins).",
      }),
    plugin: c.plugin,
    switchable: c.switchable,
    version: c.version,
  };
}

/**
 * The org's switches of platform components (spec §7, rule 5): for each kind (skill, agent
 * template, connector template) the platform components offered to the org, the read-only preview
 * of switching one off, and the switch itself; plus the super admin's read-only component list and
 * version history, and the admin console's component writes (scope, disable, visibility, template
 * versions; class `platform`). The operations
 * of the three kinds are written out (the `platform-op-*` checks read literals); their logic is
 * shared below.
 */
@Injectable()
export class ComponentsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ComponentScopeService) private readonly components: ComponentScopeService,
    @Inject(PlatformComponents) private readonly platformComponents: PlatformComponents,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** A component as a write returns it, with its orgs named (see {@link brief}). */
  private async withOrgNames(c: ComponentView) {
    const ids = [...new Set([...c.onIn, ...c.orgs])];
    const rows =
      ids.length === 0
        ? []
        : await this.kdb.db
            .selectFrom("orgs")
            .select(["id", "name"])
            .where("id", "in", ids)
            .where("deleted_at", "is", null)
            .execute();
    return brief(c, new Map(rows.map((r) => [r.id, r.name])));
  }

  /** Refuses a super-admin operation on a component another org owns (spec section 6.1). */
  private async assertNotOtherOrgs(kind: ComponentKind, id: string, orgId: string) {
    const c = (await this.components.list(kind)).find((x) => x.id === id);
    if (c !== undefined && c.owner.kind === "org" && c.owner.orgId !== orgId) {
      throw new ToolError(OTHER_ORG_COMPONENT);
    }
  }

  private async adminName(kind: ComponentKind, id: string): Promise<string> {
    return orElse(async () => {
      const c = (await this.components.list(kind)).find((x) => x.id === id);
      if (c === undefined) throw new Error("unknown");
      return named(c.name);
    }, id);
  }

  /**
   * Runs a governance write; a name clash the service reports (it names the clashing items, which
   * may be another org's own) is rethrown with {@link clashText} of the current preview, so a race
   * past the precheck never puts another org's private item in the log.
   */
  private async withoutItemNames<T>(
    kind: ComponentKind,
    id: string,
    target: ComponentTarget,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === "plugin.skill_conflict" || e.code === "agent_template.name_taken")
      ) {
        const conflicts = await orElse(
          async () => (await this.components.preview(kind, id, target)).conflicts,
          [] as ComponentScopePreview["conflicts"],
        );
        throw new ApiError(e.code, clashText(conflicts));
      }
      throw e;
    }
  }

  /**
   * What a scope change or disable would touch, as the admin console shows it (orgs named, spec
   * §14.5 item 1); each org's agents and the clashing items are counted (they are that org's own).
   */
  private async previewBrief(kind: ComponentKind, id: string, target: ComponentTarget) {
    const p = await this.components.preview(kind, id, target);
    return {
      affected: p.affected.map((a) => ({
        orgId: a.orgId,
        orgName: a.orgName,
        agents: a.agents.length,
        connectorsKept: a.connectorsKept,
      })),
      affectedOrgs: p.affected.length,
      affectedAgents: p.affected.reduce((n, a) => n + a.agents.length, 0),
      connectorsKept: p.affected.reduce((n, a) => n + a.connectorsKept, 0),
      conflicts: p.conflicts.map((c) => ({
        orgId: c.orgId,
        orgName: c.orgName,
        name: c.name,
        items: c.skills.length,
        plugins: c.plugins.length,
      })),
      scopeHash: p.scopeHash,
    };
  }

  /** The precheck of a scope change or disable: another org's component, a stale hash, a name clash. */
  private precheckTarget(
    kind: ComponentKind,
    id: string,
    target: ComponentTarget,
    hash: string | undefined,
    orgId: string,
  ) {
    return precheckBy(async () => {
      await this.assertNotOtherOrgs(kind, id, orgId);
      const p = await this.components.preview(kind, id, target);
      if (hash !== undefined && p.scopeHash !== hash) {
        throw new ApiError(
          "plugin.scope_stale",
          "The scope preview is out of date; preview again and use its new scopeHash",
        );
      }
      if (p.conflicts.length > 0) {
        throw new ApiError(
          kind === "skill" ? "plugin.skill_conflict" : "agent_template.name_taken",
          clashText(p.conflicts),
        );
      }
    });
  }

  private async available(kind: ComponentKind, cursor: string | undefined, orgId: string) {
    const all = await this.components.orgList(orgId, { kind });
    return pageOf(all.map(row), startOf(cursor), PAGE);
  }

  private nameOf(orgId: string, kind: ComponentKind, id: string): Promise<string> {
    return orElse(async () => {
      const found = (await this.components.orgList(orgId, { kind })).find((c) => c.id === id);
      if (found === undefined) throw new Error("not offered");
      return named(found.name);
    }, id);
  }

  private async disablePreview(kind: ComponentKind, id: string, orgId: string) {
    const r = await this.components.switchPreview(orgId, kind, id);
    if (r.component.locked) return { component: r.component, locked: true, confirm: null };
    if (!r.component.on) {
      return {
        component: r.component,
        preview: null,
        confirm: ALREADY_OFF,
        next: "It is not on in this org, so switching off changes nothing; pass this confirm value.",
      };
    }
    return { component: r.component, preview: r.preview, confirm: r.confirm };
  }

  private precheckSwitch(
    kind: ComponentKind,
    id: string,
    input: { enabled: boolean; confirm?: string },
    orgId: string,
  ) {
    return precheckBy(async () => {
      const r = await this.components.switchPreview(orgId, kind, id);
      const code = input.enabled
        ? r.stopped && !r.component.on
          ? "plugin.disabled"
          : null
        : r.component.locked
          ? "plugin.scope_locked"
          : r.confirm !== null && r.confirm !== input.confirm
            ? "plugin.switch_stale"
            : null;
      if (code !== null) throw new ApiError(code, REFUSED[code] as string);
    });
  }

  private async switchSummary(kind: ComponentKind, id: string, enabled: boolean, orgId: string) {
    const n = await this.nameOf(orgId, kind, id);
    const l = LABEL[kind];
    if (enabled) {
      return { zh: `在本组织启用${l.zh}「${n}」`, en: `Switch on ${l.en} "${n}" in the org` };
    }
    const p = await orElse(() => this.components.switchPreview(orgId, kind, id), null);
    const agents = p?.preview?.agents.length ?? 0;
    return {
      zh: `在本组织停用${l.zh}「${n}」：${agents} 个智能体在用`,
      en: `Switch off ${l.en} "${n}" in the org: ${agents} agents use it`,
    };
  }

  private async switchRun(
    kind: ComponentKind,
    id: string,
    input: { enabled: boolean; confirm?: string },
    operation: string,
    ctx: OperationContext,
  ) {
    const confirm =
      !input.enabled && input.confirm !== undefined && input.confirm !== ALREADY_OFF
        ? { confirm: input.confirm }
        : {};
    const r = await this.components.setSwitch(
      ctx.orgId,
      ctx.actorAccountId,
      kind,
      id,
      { enabled: input.enabled, ...confirm },
      undefined,
      viaAgent(operation, ctx),
    );
    // a switch-off of a component that is on always carries its confirm, so `preview` is a race
    return r.kind === "done"
      ? { component: r.component }
      : { preview: r.preview, confirm: r.confirm };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "skills.available",
        description:
          "List the platform skills offered to this org with whether each is on here. Each entry has an id, name, state, whether an org admin can switch it and its plugin. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/components"],
        omits: ["kind", "itemId"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => this.available("skill", input.cursor, ctx.orgId),
      }),
      defineOperation({
        id: "skills.disable-preview",
        description:
          "Preview switching a platform skill off in this org (org admins): the agents that lose it and the confirm value skills.set-enabled needs to switch it off. Show the preview to the person first.",
        input: z.object({ skillId: Id }).strict(),
        example: { skillId: EXAMPLE_ID },
        authz: { orgAction: "skills.manage" },
        // a computed preview (the web gets it from the switch route's reply): no route of its own
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with skills.available; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform skill belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call skills.disable-preview again, show it to the person, and call again with the new confirm value.",
          },
          {
            code: "plugin.skill_conflict",
            next: "An org skill has this skill's name: rename or delete the org skill first.",
          },
        ],
        run: async (input, ctx) => this.disablePreview("skill", input.skillId, ctx.orgId),
      }),
      defineOperation({
        id: "skills.set-enabled",
        description:
          "Switch a platform skill on or off in this org (org admins). Switching off needs confirm: the value skills.disable-preview returned with the preview the person saw. A component of a plugin that is off is switched on with the plugin.",
        input: z.discriminatedUnion("enabled", [
          z.object({ skillId: Id, enabled: z.literal(true) }).strict(),
          z.object({ skillId: Id, enabled: z.literal(false), confirm: Confirm }).strict(),
        ]),
        example: { skillId: EXAMPLE_ID, enabled: true },
        authz: { orgAction: "skills.manage" },
        // the route needs catalog.read; the service requires the kind's manage action
        authzNote: "service-enforced",
        mirrors: ["PUT /api/v1/orgs/:orgId/components/:kind/:id/switch"],
        omits: ["kind"],
        renames: { skillId: "id" },
        loosens: {
          confirm:
            "also takes `already-off` (skills.disable-preview's value when the component is not on), which the route's hash pattern rejects; the service checks confirm only when it is on",
        },
        confirm: "org",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with skills.available; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform skill belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call skills.disable-preview again, show it to the person, and call again with the new confirm value.",
          },
          {
            code: "plugin.skill_conflict",
            next: "An org skill has this skill's name: rename or delete the org skill first.",
          },
        ],
        precheck: (i, ctx) => this.precheckSwitch("skill", i.skillId, i, ctx.orgId),
        summary: (i, ctx) => this.switchSummary("skill", i.skillId, i.enabled, ctx.orgId),
        run: async (i, ctx) => this.switchRun("skill", i.skillId, i, "skills.set-enabled", ctx),
      }),
      defineOperation({
        id: "agent-templates.available",
        description:
          "List the platform agent templates offered to this org with whether each is on here. Each entry has an id, name, state, whether an org admin can switch it and its plugin. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/components"],
        omits: ["kind", "itemId"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => this.available("agent_template", input.cursor, ctx.orgId),
      }),
      defineOperation({
        id: "agent-templates.disable-preview",
        description:
          "Preview switching a platform agent template off in this org (org admins): the agents that lose it and the confirm value agent-templates.set-enabled needs to switch it off. Show the preview to the person first.",
        input: z.object({ templateId: Id }).strict(),
        example: { templateId: EXAMPLE_ID },
        authz: { orgAction: "agents.manage" },
        // a computed preview (the web gets it from the switch route's reply): no route of its own
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with agent-templates.available; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform agent template belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call agent-templates.disable-preview again, show it to the person, and call again with the new confirm value.",
          },
          {
            code: "agent_template.name_taken",
            next: "An org template already uses this template's type: rename or delete that one first.",
          },
        ],
        run: async (input, ctx) =>
          this.disablePreview("agent_template", input.templateId, ctx.orgId),
      }),
      defineOperation({
        id: "agent-templates.set-enabled",
        description:
          "Switch a platform agent template on or off in this org (org admins). Switching off needs confirm: the value agent-templates.disable-preview returned with the preview the person saw. A component of a plugin that is off is switched on with the plugin.",
        input: z.discriminatedUnion("enabled", [
          z.object({ templateId: Id, enabled: z.literal(true) }).strict(),
          z.object({ templateId: Id, enabled: z.literal(false), confirm: Confirm }).strict(),
        ]),
        example: { templateId: EXAMPLE_ID, enabled: true },
        authz: { orgAction: "agents.manage" },
        // the route needs catalog.read; the service requires the kind's manage action
        authzNote: "service-enforced",
        mirrors: ["PUT /api/v1/orgs/:orgId/components/:kind/:id/switch"],
        omits: ["kind"],
        renames: { templateId: "id" },
        loosens: {
          confirm:
            "also takes `already-off` (agent-templates.disable-preview's value when the component is not on), which the route's hash pattern rejects; the service checks confirm only when it is on",
        },
        confirm: "org",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with agent-templates.available; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform agent template belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call agent-templates.disable-preview again, show it to the person, and call again with the new confirm value.",
          },
          {
            code: "agent_template.name_taken",
            next: "An org template already uses this template's type: rename or delete that one first.",
          },
        ],
        precheck: (i, ctx) => this.precheckSwitch("agent_template", i.templateId, i, ctx.orgId),
        summary: (i, ctx) =>
          this.switchSummary("agent_template", i.templateId, i.enabled, ctx.orgId),
        run: async (i, ctx) =>
          this.switchRun("agent_template", i.templateId, i, "agent-templates.set-enabled", ctx),
      }),
      defineOperation({
        id: "connectors.template-disable-preview",
        description:
          "Preview switching a platform connector template off in this org (org admins): the agents that lose it and the confirm value connectors.set-template-enabled needs to switch it off. Show the preview to the person first.",
        input: z.object({ templateId: Id }).strict(),
        example: { templateId: EXAMPLE_ID },
        authz: { orgAction: "connectors.manage" },
        // a computed preview (the web gets it from the switch route's reply): no route of its own
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with connectors.templates; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform connector template belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call connectors.template-disable-preview again, show it to the person, and call again with the new confirm value.",
          },
        ],
        run: async (input, ctx) =>
          this.disablePreview("connector_template", input.templateId, ctx.orgId),
      }),
      defineOperation({
        id: "connectors.set-template-enabled",
        description:
          "Switch a platform connector template on or off in this org (org admins). Switching off needs confirm: the value connectors.template-disable-preview returned with the preview the person saw. A component of a plugin that is off is switched on with the plugin.",
        input: z.discriminatedUnion("enabled", [
          z.object({ templateId: Id, enabled: z.literal(true) }).strict(),
          z.object({ templateId: Id, enabled: z.literal(false), confirm: Confirm }).strict(),
        ]),
        example: { templateId: EXAMPLE_ID, enabled: true },
        authz: { orgAction: "connectors.manage" },
        // the route needs catalog.read; the service requires the kind's manage action
        authzNote: "service-enforced",
        mirrors: ["PUT /api/v1/orgs/:orgId/components/:kind/:id/switch"],
        omits: ["kind"],
        renames: { templateId: "id" },
        loosens: {
          confirm:
            "also takes `already-off` (connectors.template-disable-preview's value when the component is not on), which the route's hash pattern rejects; the service checks confirm only when it is on",
        },
        confirm: "org",
        errors: [
          {
            code: "component.not_found",
            next: "Check the id with connectors.templates; only components offered to the org can be switched.",
          },
          {
            code: "plugin.scope_locked",
            next: "This platform connector template belongs to a built-in plugin: it is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The component is disabled on the platform: enable it again in the admin console under Components, then call again.",
              orgAdmin: "The super admin disabled this component on the platform; ask them.",
              member: "The super admin disabled this component on the platform; ask an org admin.",
            },
          },
          {
            code: "plugin.switch_stale",
            next: "What switching it off affects changed: call connectors.template-disable-preview again, show it to the person, and call again with the new confirm value.",
          },
        ],
        precheck: (i, ctx) => this.precheckSwitch("connector_template", i.templateId, i, ctx.orgId),
        summary: (i, ctx) =>
          this.switchSummary("connector_template", i.templateId, i.enabled, ctx.orgId),
        run: async (i, ctx) =>
          this.switchRun(
            "connector_template",
            i.templateId,
            i,
            "connectors.set-template-enabled",
            ctx,
          ),
      }),
      defineOperation({
        id: "plugins.components",
        description:
          "List the platform's components of one kind (super admin): skills, agent templates or connector templates with their plugin, scope, disabled state and how many orgs they are on in (another org's own components are only counted). Pages by 50: pass the returned next as params.cursor. Scope, disable and visibility are changed in the admin console.",
        input: z.object({ kind: ComponentParams.shape.kind, cursor: Cursor.optional() }).strict(),
        example: { kind: "skill" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/components"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.components.list(input.kind);
          // another org's own rows are only counted
          const visible = all.filter((c) => c.owner.kind !== "org" || c.owner.orgId === ctx.orgId);
          const rows = visible.map((c) => ({
            id: c.id,
            name: c.name,
            state: stateOf(c),
            plugin: c.plugin,
            scope: c.scope,
            onIn: c.onIn.length,
          }));
          return {
            ...pageOf(rows, startOf(input.cursor), PAGE),
            otherOrgComponents: all.length - visible.length,
          };
        },
      }),
      defineOperation({
        id: "plugins.component-scope-preview",
        description:
          "Preview a platform component's scope change, deployment-level disable or return to its plugin's scope (super admin): the orgs affected (with how many agents in each), name clashes (the org named, its clashing items counted), and the scopeHash plugins.set-component-scope or plugins.set-component-disabled takes. Send exactly one of scope (with orgs for named), disabled: true or follow: true.",
        input: ComponentScopePreviewFields.extend({
          kind: ComponentParams.shape.kind,
          componentId: Id,
        })
          .strict()
          .refine(componentScopeRules.exactlyOnePreviewTarget, {
            message:
              "send exactly one of scope (with orgs for named), disabled: true or follow: true",
          })
          .refine(componentScopeRules.orgsNeedScope, {
            message: "orgs: only allowed with scope named",
            path: ["orgs"],
          }),
        example: { kind: "skill", componentId: EXAMPLE_ID, scope: "optional" as const },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/components/:kind/:id/scope/preview"],
        renames: { componentId: "id" },
        confirm: "read",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
          {
            code: "plugin.builtin",
            next: "The component belongs to a built-in plugin: it is on in every org and its scope cannot be changed.",
          },
        ],
        run: async (i, ctx) => {
          await this.assertNotOtherOrgs(i.kind as ComponentKind, i.componentId, ctx.orgId);
          const p = await this.previewBrief(
            i.kind as ComponentKind,
            i.componentId,
            previewTarget(i),
          );
          return p;
        },
      }),
      defineOperation({
        id: "plugins.set-component-scope",
        description:
          "Give a platform component its own scope (all, optional or named with orgs), or make it follow its plugin's scope again (super admin), for every org at once: pass the scopeHash plugins.component-scope-preview returned. A stale preview or an org whose own skill has the component's name is refused.",
        input: ComponentScopeFields.extend({
          kind: ComponentParams.shape.kind,
          componentId: Id,
        })
          .strict()
          .refine(componentScopeRules.scopeXorFollow, {
            message: "send either scope (with orgs for named) or follow: true",
          })
          .refine(componentScopeRules.orgsNeedScope, {
            message: "orgs: only allowed with scope named",
            path: ["orgs"],
          }),
        example: {
          kind: "skill",
          componentId: EXAMPLE_ID,
          scope: "optional" as const,
          scopeHash: "abc123",
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/components/:kind/:id/scope"],
        renames: { componentId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
          {
            code: "plugin.scope_stale",
            next: "Call plugins.component-scope-preview again and use its new scopeHash.",
          },
          {
            code: "plugin.skill_conflict",
            next: "An org's own skill has this skill's name: that org renames or deletes it first.",
          },
          {
            code: "plugin.builtin",
            next: "The component belongs to a built-in plugin: its scope cannot be changed.",
          },
        ],
        precheck: (i, ctx) =>
          this.precheckTarget(
            i.kind as ComponentKind,
            i.componentId,
            scopeTarget(i),
            i.scopeHash,
            ctx.orgId,
          ),
        summary: async (i) => {
          const kind = i.kind as ComponentKind;
          const n = await this.adminName(kind, i.componentId);
          const sc = scopeText(i);
          const p = await orElse(
            () => this.previewBrief(kind, i.componentId, scopeTarget(i)),
            null,
          );
          const tail =
            p === null
              ? { zh: "", en: "" }
              : {
                  zh: `；影响 ${p.affectedOrgs} 个组织、${p.affectedAgents} 个智能体`,
                  en: `; ${p.affectedOrgs} orgs and ${p.affectedAgents} agents affected`,
                };
          return {
            zh: `把${LABEL[kind].zh}「${n}」的范围设为${sc.zh}${tail.zh}`,
            en: `Set the scope of ${LABEL[kind].en} "${n}" to ${sc.en}${tail.en}`,
          };
        },
        run: async (i, ctx) => {
          await this.assertNotOtherOrgs(i.kind as ComponentKind, i.componentId, ctx.orgId);
          return {
            component: await this.withOrgNames(
              await this.withoutItemNames(
                i.kind as ComponentKind,
                i.componentId,
                scopeTarget(i),
                () =>
                  this.components.setScope(
                    ctx.actorAccountId,
                    i.kind as ComponentKind,
                    i.componentId,
                    scopeBody(i),
                    { auditDetail: viaAgent("plugins.set-component-scope", ctx) },
                  ),
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "plugins.set-component-disabled",
        description:
          "Disable a platform component on the whole deployment, or enable it again (super admin). Disabling needs the scopeHash of plugins.component-scope-preview called with disabled: true; enabling needs none. Orgs keep their own switches.",
        input: ComponentDisabledSchema.extend({
          kind: ComponentParams.shape.kind,
          componentId: Id,
        }).strict(),
        example: { kind: "skill", componentId: EXAMPLE_ID, disabled: true, scopeHash: "abc123" },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/components/:kind/:id/disabled"],
        renames: { componentId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
          {
            code: "plugin.scope_stale",
            next: "Call plugins.component-scope-preview with disabled: true again and use its new scopeHash.",
          },
          {
            code: "validation_failed",
            next: "Disabling needs scopeHash from plugins.component-scope-preview with disabled: true.",
          },
        ],
        precheck: (i, ctx) =>
          i.disabled && i.scopeHash === undefined
            ? Promise.resolve({
                ok: false as const,
                code: "validation_failed",
                message: "scopeHash: required when disabling",
              })
            : this.precheckTarget(
                i.kind as ComponentKind,
                i.componentId,
                { disabled: i.disabled },
                i.disabled ? i.scopeHash : undefined,
                ctx.orgId,
              ),
        summary: async (i) => {
          const kind = i.kind as ComponentKind;
          const n = await this.adminName(kind, i.componentId);
          return i.disabled
            ? {
                zh: `在整个平台停用${LABEL[kind].zh}「${n}」`,
                en: `Disable ${LABEL[kind].en} "${n}" on the whole platform`,
              }
            : {
                zh: `在整个平台重新启用${LABEL[kind].zh}「${n}」`,
                en: `Enable ${LABEL[kind].en} "${n}" on the platform again`,
              };
        },
        run: async (i, ctx) => {
          await this.assertNotOtherOrgs(i.kind as ComponentKind, i.componentId, ctx.orgId);
          return {
            component: await this.withOrgNames(
              await this.withoutItemNames(
                i.kind as ComponentKind,
                i.componentId,
                { disabled: i.disabled },
                () =>
                  this.components.setDisabled(
                    ctx.actorAccountId,
                    i.kind as ComponentKind,
                    i.componentId,
                    {
                      disabled: i.disabled,
                      ...(i.scopeHash !== undefined && { scopeHash: i.scopeHash }),
                    },
                    { auditDetail: viaAgent("plugins.set-component-disabled", ctx) },
                  ),
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "plugins.set-component-shown",
        description:
          "Show a platform component to orgs outside its named list, or hide it from them (super admin). Showing does not make it usable there; those orgs' admins can then switch it on.",
        input: ComponentShownSchema.extend({
          kind: ComponentParams.shape.kind,
          componentId: Id,
        }).strict(),
        example: { kind: "skill", componentId: EXAMPLE_ID, shownToOthers: true },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/components/:kind/:id/shown"],
        renames: { componentId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.assertNotOtherOrgs(i.kind as ComponentKind, i.componentId, ctx.orgId),
          ),
        summary: async (i) => {
          const kind = i.kind as ComponentKind;
          const n = await this.adminName(kind, i.componentId);
          return i.shownToOthers
            ? {
                zh: `向其他组织展示${LABEL[kind].zh}「${n}」`,
                en: `Show ${LABEL[kind].en} "${n}" to other orgs`,
              }
            : {
                zh: `对其他组织隐藏${LABEL[kind].zh}「${n}」`,
                en: `Hide ${LABEL[kind].en} "${n}" from other orgs`,
              };
        },
        run: async (i, ctx) => {
          await this.assertNotOtherOrgs(i.kind as ComponentKind, i.componentId, ctx.orgId);
          return {
            component: await this.withOrgNames(
              await this.components.setShown(
                ctx.actorAccountId,
                i.kind as ComponentKind,
                i.componentId,
                i.shownToOthers,
                { auditDetail: viaAgent("plugins.set-component-shown", ctx) },
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "plugins.update-agent-template",
        description:
          "Publish a new version of a platform agent template on its own (super admin): content is the template markdown file, which must keep the template's name. It serves in orgs at once. Takes the template id from plugins.components with kind agent_template.",
        input: ComponentTemplateVersionSchema.extend({ templateId: Id }).strict(),
        example: {
          templateId: EXAMPLE_ID,
          content: "---\nname: support-triage\n---\nTriage requests.",
        },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/components/agent_template/:id/versions"],
        renames: { templateId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
          {
            code: "validation_failed",
            next: "Fix the template file as the message says; it must keep the template's name.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.assertNotOtherOrgs("agent_template", i.templateId, ctx.orgId)),
        summary: async (i) => {
          const n = await this.adminName("agent_template", i.templateId);
          return {
            zh: `发布平台智能体模板「${n}」的新版本`,
            en: `Publish a new version of platform agent template "${n}"`,
          };
        },
        run: async (i, ctx) => {
          await this.assertNotOtherOrgs("agent_template", i.templateId, ctx.orgId);
          return this.platformComponents.uploadAgentTemplateVersion(
            {
              accountId: ctx.actorAccountId,
              auditDetail: viaAgent("plugins.update-agent-template", ctx),
            },
            i.templateId,
            i.content,
          );
        },
      }),
      defineOperation({
        id: "plugins.component-versions",
        description:
          "List a platform component's versions, newest first (super admin): version, the plugin version it came from, and whether it was updated on its own. A connector template keeps only its current version. Takes the component id from plugins.components.",
        input: z.object({ kind: ComponentParams.shape.kind, componentId: Id }).strict(),
        example: { kind: "skill", componentId: EXAMPLE_ID },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/components/:kind/:id/versions"],
        renames: { componentId: "id" },
        confirm: "read",
        errors: [
          {
            code: "component.not_found",
            next: "Check the component id and kind with plugins.components.",
          },
        ],
        run: async (input) => ({
          versions: await this.components.versions(input.kind as ComponentKind, input.componentId),
        }),
      }),
    ]);
  }
}
