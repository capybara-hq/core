import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ComponentParams } from "../../catalog/component-scope.schemas.js";
import {
  ComponentScopeService,
  type OrgOfferedComponentView,
} from "../../catalog/component-scope.service.js";
import type { ComponentKind } from "../../catalog/component-state.js";
import { ApiError } from "../../errors.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { redactOrgs } from "../redact-orgs.js";
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
 * version history. Scope, disable and visibility changes stay in the admin console. The operations
 * of the three kinds are written out (the `platform-op-*` checks read literals); their logic is
 * shared below.
 */
@Injectable()
export class ComponentsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ComponentScopeService) private readonly components: ComponentScopeService,
  ) {}

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
        // the web previews through the switch route itself (no confirm); writes nothing here
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
        // the web previews through the switch route itself (no confirm); writes nothing here
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
        // the web previews through the switch route itself (no confirm); writes nothing here
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
          "List the platform's components of one kind (super admin): skills, agent templates or connector templates with their plugin, scope, disabled state and how many orgs they are on in. Orgs are given as counts only. Pages by 50: pass the returned next as params.cursor. Scope, disable and visibility are changed in the admin console.",
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
            state: c.disabled || c.pluginStopped ? "disabled" : "on",
            plugin: c.plugin,
            scope: c.scope,
            onIn: c.onIn,
          }));
          return redactOrgs({
            ...pageOf(rows, startOf(input.cursor), PAGE),
            otherOrgComponents: all.length - visible.length,
          });
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
