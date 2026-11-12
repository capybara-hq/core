import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { AgentView } from "../../agents/agent-lookup.js";
import { AgentProfileService } from "../../agents/agent-profile.service.js";
import {
  AgentCreateBody,
  AgentCreateDefinition,
  AgentFromTemplateBody,
  AgentFromTemplatePreviewBody,
  AgentPathParams,
  AgentProfileBody,
  AgentUpdateBody,
  PendingConnectorBindBody,
  PendingConnectorParams,
} from "../../agents/agents.schemas.js";
import { AgentsService } from "../../agents/agents.service.js";
import { AgentDefinitionSchema, type ModelRef } from "../../agents/definition.js";
import { AgentsFromTemplate } from "../../agents/from-template.service.js";
import { OrgAgentTemplates } from "../../agents/org-templates.js";
import { PendingConnectorsService } from "../../agents/pending-connectors.service.js";
import { PresetAvatarSchema } from "../../agents/profile.js";
import { CatalogRequestsService } from "../../catalog/requests.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { roleAtLeast } from "../../orgs/roles.js";
import { ProviderRegistry } from "../../runtime/providers.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { ConnectorsService } from "../../tools/connectors.service.js";
import {
  type ConfirmClass,
  defineOperation,
  type OperationContext,
  type PrecheckResult,
} from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { roleOf } from "./role.js";
import { named, orElse } from "./summary.js";

const AgentId = AgentPathParams.shape.agentId.max(100);
/** The request's definition (create form): the operations tighten its fields, never redeclare them. */
const Def = AgentCreateDefinition.shape;
/** Every string the model sends is bounded (the route's tool refs and model strings are not). */
const Short = z.string().min(1).max(200);

const Model = Def.model.extend({ provider: Short, model: Short }).strict();

/**
 * Whether `next` sets an `allow` that `current` does not have (decision 2026-11-09: `allow` on a
 * connector tool lets an agent call it without asking). Such a change is confirmed every time and
 * never remembered, so an agent can never loosen its own policies on a grant the person remembered
 * for ordinary edits.
 */
function addsAllow(
  next: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
): boolean {
  return Object.entries(next ?? {}).some(([k, v]) => v === "allow" && current?.[k] !== "allow");
}

/** The definition fields an agent can set through the tool; the rest keep the web's defaults. */
const Fields = {
  name: Def.name,
  description: Def.description.unwrap(),
  instructions: Def.instructions.unwrap(),
  model: Model,
  /**
   * Tools turned off (tools default-on spec §8): an agent has every builtin, every tool of the
   * extensions enabled in the org and every tool of the org's connectors except these.
   */
  disabledTools: Def.disabledTools.unwrap(),
  toolPolicies: z.record(Short, Def.toolPolicies.unwrap().valueType),
  /** Skills turned off (skills default-on spec §4); `skills.writePolicy` stays the web's. */
  disabledSkills: Def.disabledSkills.unwrap(),
  subagents: Def.subagents.unwrap(),
};

/**
 * The profile fields the tool sets: a preset avatar (or none) and the quick actions. An uploaded
 * image is the web's (byte upload); the description moves into the agent definition (run-context
 * spec §3.5), so it is not mirrored here.
 */
const Profile = AgentProfileBody.shape;
const PresetAvatar = PresetAvatarSchema;

/** One change of `agents.update-profile` as the card says it. */
function profileChanges(i: {
  avatar?: { id: string } | null | undefined;
  quickActions?: { title: string }[] | undefined;
}): { zh: string[]; en: string[] } {
  const zh: string[] = [];
  const en: string[] = [];
  if (i.avatar === null) {
    zh.push("移除头像");
    en.push("remove the avatar");
  } else if (i.avatar !== undefined) {
    zh.push(`头像设为预设「${i.avatar.id}」`);
    en.push(`set the avatar to preset "${i.avatar.id}"`);
  }
  if (i.quickActions !== undefined && i.quickActions.length === 0) {
    zh.push("清空快捷操作");
    en.push("clear the quick actions");
  } else if (i.quickActions !== undefined) {
    // a count only: the titles are model text (spec §6.3); the card's parameters list them
    const n = i.quickActions.length;
    zh.push(`快捷操作设为 ${n} 条（替换现有的）`);
    en.push(`set ${n} quick action${n === 1 ? "" : "s"} (replacing the current ones)`);
  }
  return { zh, en };
}

const WEB_ONLY =
  "Agents created with the Platform tool are private, and no agent's visibility can be changed with it; sharing an agent with the org or with members is done on the agents page of the web app.";

const brief = (a: AgentView) => ({
  id: a.id,
  name: a.definition.name,
  description: a.profile.description,
  visibility: a.visibility,
  ownerAccountId: a.ownerAccountId,
  currentVersion: a.currentVersion,
  model: a.definition.model,
  createdFromTemplate: a.createdFrom?.templateId ?? null,
  updatedAt: a.updatedAt,
});

/** Agent operations of the `Platform` tool (spec §7); visibility is the person's own agents. */
@Injectable()
export class AgentsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentProfileService) private readonly profiles: AgentProfileService,
    @Inject(AgentsFromTemplate) private readonly fromTemplate: AgentsFromTemplate,
    @Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates,
    @Inject(PendingConnectorsService) private readonly pending: PendingConnectorsService,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /**
   * The edit rule the service enforces, read before the card: the agent is visible, and the actor
   * owns it or is an org admin. Returns the agent too for the checks that follow.
   */
  private async editCheck(
    agentId: string,
    ctx: OperationContext,
  ): Promise<PrecheckResult & { agent?: AgentView }> {
    let agent: AgentView;
    try {
      agent = await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId);
    } catch (e) {
      const r = await precheckBy(() => Promise.reject(e));
      if (!r.ok) return r;
      throw e;
    }
    if (agent.ownerAccountId !== ctx.actorAccountId) {
      const role = await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId);
      if (role === null || !roleAtLeast(role, "admin")) {
        return {
          ok: false,
          code: "forbidden",
          message: "Only the agent owner or an organization admin can modify it",
        };
      }
    }
    return { ok: true, agent };
  }

  private agentName(ctx: OperationContext, agentId: string): Promise<string> {
    return orElse(
      async () =>
        named((await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId)).definition.name),
      agentId,
    );
  }

  /**
   * `agents.update`'s class (spec §13): `personal` (may be remembered) only on a private agent the
   * actor owns; any other agent the actor may edit is shared, so each change is confirmed.
   */
  private async updateClass(
    agentId: string,
    toolPolicies: Record<string, string> | undefined,
    ctx: OperationContext,
  ): Promise<ConfirmClass> {
    const a = await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId);
    if (addsAllow(toolPolicies, a.definition.toolPolicies)) return "org";
    return a.visibility === "private" && a.ownerAccountId === ctx.actorAccountId
      ? "personal"
      : "org";
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "agents.list",
        description:
          "List the agents you can see in the org: your own and those shared with the org or with you. Each entry has an id, name, visibility, owner, version and model.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents"],
        confirm: "read",
        run: async (_input, ctx) => ({
          agents: (await this.agents.listVisible(ctx.orgId, ctx.actorAccountId)).map(brief),
        }),
      }),
      defineOperation({
        id: "agents.get",
        description:
          "Read one agent you can see with its full definition (description, instructions, model, the tools it turns off (disabledTools: an agent has every tool the org offers except these), tool policies, the skills it turns off (disabledSkills: an agent has every skill on in the org except these), skills.writePolicy and sub-agents) and its profile (avatar, description, quick actions). Takes the agent id from agents.list.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId"],
        confirm: "read",
        run: async (input, ctx) => ({
          agent: await this.agents.get(ctx.orgId, input.agentId, ctx.actorAccountId),
        }),
      }),
      defineOperation({
        id: "agents.create",
        description:
          'Create a new private agent owned by you, with a name, a model and optionally instructions, disabledTools, tool policies, disabledSkills and sub-agents. An agent has every tool the org offers (all built-in tools, the tools of the extensions on in the org and of the org\'s connectors) unless disabledTools turns it off: { kind: "builtin", name }, { kind: "plugin", plugin, tools: "all" | [names] } or { kind: "connector", connectorId, tools: "all" | [names] }. Likewise, an agent has every skill on in the org unless disabledSkills turns it off: { kind: "plugin", plugin, skills: "all" | [names] } for skills of a plugin (skills.list gives the plugin of each), or { kind: "skill", skillId } for a skill without a plugin; the skills of builtin plugins (builtin in skills.list) and the own skills of the agent cannot be turned off. Agents created with the Platform tool are private; sharing an agent with the org or with members is done on the agents page of the web app.',
        input: z
          .object({
            definition: z
              .object({
                name: Fields.name,
                instructions: Fields.instructions.optional(),
                model: Fields.model,
                disabledTools: Fields.disabledTools.optional(),
                toolPolicies: Fields.toolPolicies.optional(),
                disabledSkills: Fields.disabledSkills.optional(),
                subagents: Fields.subagents.optional(),
              })
              .strict(),
            // only "private" passes; any other is refused with where to share it (WEB_ONLY)
            visibility: AgentCreateBody.shape.visibility.optional(),
          })
          .strict(),
        example: {
          definition: {
            name: "Report writer",
            instructions: "Write clear weekly reports from the notes you are given.",
            model: { provider: "anthropic", model: "claude-sonnet-4-5" },
          },
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents"],
        // sharing and the avatar are set on the web
        omits: ["memberIds", "profile"],
        loosens: { visibility: "optional: the operation creates private agents only" },
        confirm: "personal",
        // an `allow` loosens: never on a remembered grant
        confirmFor: async (i) =>
          addsAllow(i.definition.toolPolicies, undefined) ? "org" : "personal",
        summary: (i) => ({
          zh: `新建私有智能体「${i.definition.name}」`,
          en: `Create private agent "${i.definition.name}"`,
        }),
        run: async (input, ctx) => {
          if (input.visibility !== undefined && input.visibility !== "private") {
            throw new ToolError(WEB_ONLY);
          }
          const d = input.definition;
          const parsed = AgentDefinitionSchema.omit({ pendingConnectors: true }).parse({
            name: d.name,
            model: d.model,
            ...(d.disabledTools !== undefined && { disabledTools: d.disabledTools }),
            ...(d.toolPolicies !== undefined && { toolPolicies: d.toolPolicies }),
            ...(d.disabledSkills !== undefined && { disabledSkills: d.disabledSkills }),
            ...(d.subagents !== undefined && { subagents: d.subagents }),
          });
          return this.agents.create(
            ctx.orgId,
            ctx.actorAccountId,
            {
              definition: { ...parsed, instructions: d.instructions },
              visibility: "private",
            },
            undefined,
            viaAgent("agents.create", ctx),
          );
        },
      }),
      defineOperation({
        id: "agents.update",
        description:
          'Change an agent you may edit: your own, private or shared, and as an org admin any agent of the org. Send the version you read from agents.get and only the fields to change; the others keep their value. The description (one short paragraph, "" removes it) is saved with the definition; the avatar and quick actions are changed with agents.update-profile. disabledTools replaces the whole list of turned-off tools (send [] to turn every tool on). disabledSkills replaces the whole list of turned-off skills (send [] to turn every skill on); an agent has every skill on in the org unless disabledSkills turns it off: { kind: "plugin", plugin, skills: "all" | [names] } for skills of a plugin (skills.list gives the plugin of each), or { kind: "skill", skillId } for a skill without a plugin; the skills of builtin plugins (builtin in skills.list) and the own skills of the agent cannot be turned off. A version that is no longer current is refused, so read the agent again first. The visibility cannot be changed here (that is done on the agents page of the web app). A change to your own private agent may be remembered by the person; a change to a shared agent, or one that sets a tool policy to allow, is confirmed every time.',
        input: z
          .object({
            agentId: AgentId,
            version: AgentUpdateBody.shape.expectedVersion.unwrap(),
            name: Fields.name.optional(),
            description: Fields.description.optional(),
            instructions: Fields.instructions.optional(),
            model: Fields.model.optional(),
            disabledTools: Fields.disabledTools.optional(),
            toolPolicies: Fields.toolPolicies.optional(),
            disabledSkills: Fields.disabledSkills.optional(),
            subagents: Fields.subagents.optional(),
          })
          .strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          version: 3,
          instructions: "Write short weekly reports, three bullets at most.",
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/agents/:agentId"],
        // flat: the definition's editable fields at the top, merged into the current definition;
        // `version` is the route's `expectedVersion`, required here; visibility is the web's
        omits: ["visibility", "memberIds"],
        renames: {
          version: "expectedVersion",
          name: "definition.name",
          description: "definition.description",
          instructions: "definition.instructions",
          model: "definition.model",
          disabledTools: "definition.disabledTools",
          toolPolicies: "definition.toolPolicies",
          disabledSkills: "definition.disabledSkills",
          subagents: "definition.subagents",
        },
        confirm: "personal",
        errors: [
          {
            code: "agent.version_conflict",
            next: "The agent changed since you read it: read it again with agents.get, then send its current version.",
          },
        ],
        confirmFor: (i, ctx) => this.updateClass(i.agentId, i.toolPolicies, ctx),
        summary: async (i, ctx) => {
          const a = await this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId);
          const name = named(a.definition.name);
          return a.visibility === "private"
            ? {
                zh: `修改私有智能体「${name}」（版本 ${i.version}）`,
                en: `Update private agent "${name}" (version ${i.version})`,
              }
            : {
                zh: `修改共享智能体「${name}」（版本 ${i.version}）`,
                en: `Update shared agent "${name}" (version ${i.version})`,
              };
        },
        run: async (input, ctx) => {
          const { agentId, version, ...patch } = input;
          const current = (await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId))
            .definition;
          // the files are the authoring form of the prompt: a new prompt replaces them
          const { instructionFiles, ...base } = current;
          const definition = {
            ...(patch.instructions === undefined && instructionFiles !== undefined
              ? { ...base, instructionFiles }
              : base),
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.instructions !== undefined && { instructions: patch.instructions }),
            ...(patch.model !== undefined && { model: patch.model as ModelRef }),
            ...(patch.disabledTools !== undefined && { disabledTools: patch.disabledTools }),
            ...(patch.toolPolicies !== undefined && { toolPolicies: patch.toolPolicies }),
            ...(patch.disabledSkills !== undefined && { disabledSkills: patch.disabledSkills }),
            ...(patch.subagents !== undefined && { subagents: patch.subagents }),
          };
          return this.agents.update(
            ctx.orgId,
            agentId,
            ctx.actorAccountId,
            { definition, expectedVersion: version },
            undefined,
            viaAgent("agents.update", ctx),
          );
        },
      }),
      defineOperation({
        id: "agents.update-profile",
        description:
          "Change how an agent you may edit looks to people: its avatar (one of the preset animals, or null for none) and its quick actions (the prompts offered when a conversation starts; the list you send replaces the current one, [] clears it). Send at least one of the two. The current profile is in agents.get. The description is part of the definition: change it with agents.update. A custom avatar image is uploaded on the agents page of the web app. A change to your own private agent may be remembered by the person; a change to a shared agent is confirmed every time.",
        input: z
          .object({
            agentId: AgentId,
            // a preset only: the route's `upload` kind needs a byte upload, which stays on the web
            avatar: PresetAvatar.nullable().optional(),
            quickActions: Profile.quickActions,
          })
          .strict()
          .refine((i) => i.avatar !== undefined || i.quickActions !== undefined, {
            message: "Send avatar, quickActions or both",
          }),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          avatar: { kind: "preset", id: "owl" },
          quickActions: [
            { title: "Weekly report", body: "Write this week's report from my notes." },
          ],
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/agents/:agentId/profile"],
        // `expectedUpdatedAt` is read by the operation itself (the route takes no description: it
        // is saved with the definition, agents.update). The narrower avatar (no `upload` kind)
        // needs no declaration: an input that accepts less than the route passes the parity test.
        omits: ["expectedUpdatedAt"],
        confirm: "personal",
        confirmFor: (i, ctx) => this.updateClass(i.agentId, undefined, ctx),
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; only agents you can see can be changed.",
          },
          {
            code: "forbidden",
            next: {
              orgAdmin: "Only the agent's owner or an org admin can change its profile.",
              member:
                "Only the agent's owner or an org admin can change its profile; ask the owner, or an org admin.",
            },
          },
          {
            code: "agent.profile_conflict",
            next: "Someone changed the profile while you were waiting: read it again with agents.get, then call again.",
          },
        ],
        precheck: async (i, ctx) => {
          const { agent: _a, ...check } = await this.editCheck(i.agentId, ctx);
          return check;
        },
        summary: async (i, ctx) => {
          const a = await orElse(
            () => this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId),
            null,
          );
          const n = named(a?.definition.name ?? i.agentId);
          const c = profileChanges(i);
          return a?.visibility === "private"
            ? {
                zh: `修改私有智能体「${n}」的资料：${c.zh.join("；")}`,
                en: `Update the profile of private agent "${n}": ${c.en.join("; ")}`,
              }
            : {
                zh: `修改共享智能体「${n}」的资料：${c.zh.join("；")}`,
                en: `Update the profile of shared agent "${n}": ${c.en.join("; ")}`,
              };
        },
        run: async (input, ctx) => {
          // the profile as of now: the person approved this change, not a guard on an earlier read
          const current = await this.agents.get(ctx.orgId, input.agentId, ctx.actorAccountId);
          const profile = await this.profiles.update(
            ctx.orgId,
            input.agentId,
            ctx.actorAccountId,
            {
              ...(input.avatar !== undefined && { avatar: input.avatar }),
              ...(input.quickActions !== undefined && { quickActions: input.quickActions }),
            },
            current.profile.updatedAt,
            undefined,
            viaAgent("agents.update-profile", ctx),
          );
          return { id: input.agentId, profile };
        },
      }),
      defineOperation({
        id: "agents.preview-from-template",
        description:
          "Preview creating an agent from an agent template: what carries over, what is pending (connectors the org has not set up) or unavailable, the model that would be used, and a previewHash. Each skill the template names is carried when the org has it and unavailable otherwise; the new agent has every skill on in the org except those the template's disallowedSkills turns off. agents.create-from-template needs that hash.",
        input: AgentFromTemplatePreviewBody,
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10" },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/from-template/preview"],
        confirm: "read",
        run: async (input, ctx) => this.fromTemplate.preview(ctx.orgId, input.templateId),
      }),
      defineOperation({
        id: "agents.create-from-template",
        description:
          "Create a private agent from an agent template, with the previewHash of agents.preview-from-template; a changed template or org makes the hash stale and the preview must be redone. Connectors the template needs that the org lacks become pending entries and a setup request goes to the org admins. Agents created with the Platform tool are private; sharing an agent with the org or with members is done on the agents page of the web app.",
        input: AgentFromTemplateBody.pick({
          templateId: true,
          name: true,
          previewHash: true,
          visibility: true,
        })
          // the model with bounded strings (the route's are not)
          .extend({ model: Model.optional() })
          .strict(),
        example: {
          templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10",
          name: "My triage agent",
          previewHash: `${"0".repeat(64)}.${"0".repeat(16)}`,
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/from-template"],
        // a members agent and its avatar are set on the web
        omits: ["members", "avatar"],
        confirm: "personal",
        errors: [
          {
            code: "agent.template_preview_stale",
            next: "Call agents.preview-from-template again and use its new previewHash.",
          },
          {
            code: "component.not_found",
            next: "Check the template id with agent-templates.list; this org cannot use that template.",
          },
          {
            code: "agent.model_unavailable",
            next: {
              superAdmin:
                "No model is set up: configure a model provider in the admin console, then call again.",
              orgAdmin:
                "No model is available in this deployment; ask the super admin to set one up.",
              member: "No model is available in this deployment; ask an org admin.",
            },
          },
          {
            code: "agent.visibility_web_only",
            next: "Leave visibility out (the agent is private), and share it on the agents page of the web app.",
          },
        ],
        precheck: async (i, ctx) => {
          if (i.visibility !== undefined && i.visibility !== "private") {
            return { ok: false, code: "agent.visibility_web_only", message: WEB_ONLY };
          }
          return precheckBy(() =>
            this.fromTemplate.check(ctx.orgId, {
              templateId: i.templateId,
              previewHash: i.previewHash,
              ...(i.model !== undefined && { model: i.model }),
            }),
          );
        },
        summary: async (i, ctx) => {
          const t = named(
            await orElse(
              async () => (await this.orgTemplates.detail(ctx.orgId, i.templateId)).name,
              i.templateId,
            ),
          );
          return {
            zh: `从模板「${t}」新建私有智能体「${named(i.name)}」`,
            en: `Create private agent "${named(i.name)}" from template "${t}"`,
          };
        },
        run: async (input, ctx) => {
          if (input.visibility !== undefined && input.visibility !== "private") {
            throw new ToolError(WEB_ONLY);
          }
          return this.fromTemplate.create(
            ctx.orgId,
            ctx.actorAccountId,
            {
              templateId: input.templateId,
              name: input.name,
              previewHash: input.previewHash,
              visibility: "private",
              ...(input.model !== undefined && { model: input.model }),
            },
            undefined,
            viaAgent("agents.create-from-template", ctx),
          );
        },
      }),
      defineOperation({
        id: "agents.delete",
        description:
          "Delete an agent you may edit: your own, and as an org admin any agent of the org. Its conversations stay readable but it can no longer be used, its eval runs stop and its pending skill changes are cancelled. The person confirms every delete; it is never remembered. The agent you are running as cannot be deleted.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.create" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/agents/:agentId"],
        confirm: "personal",
        // destructive: asked every time and never remembered, a shared agent as an org write
        rememberable: false,
        confirmFor: (i, ctx) => this.updateClass(i.agentId, undefined, ctx),
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; you can only delete agents you own, and org admins any agent of the org.",
          },
          {
            code: "forbidden",
            next: {
              orgAdmin: "Only the agent's owner or an org admin can delete it.",
              member: "Only the agent's owner or an org admin can delete it; ask one of them.",
            },
          },
          {
            code: "agent.delete_current",
            next: "This is the agent you are running as: ask the person to delete it on the agents page of the web app, or delete a different agent.",
          },
        ],
        precheck: async (i, ctx) => {
          // the run's agent is the root conversation's: a sub-agent runs under its parent's agent
          const rootId = await rootConversationOf(this.kdb.db, ctx.conversationId);
          const root = await this.kdb.db
            .selectFrom("conversations")
            .select("agent_id")
            .where("id", "=", rootId)
            .executeTakeFirst();
          if (i.agentId === ctx.agentId || i.agentId === root?.agent_id) {
            return {
              ok: false,
              code: "agent.delete_current",
              message: "The agent you are running as cannot be deleted from here.",
            };
          }
          const { agent: _a, ...check } = await this.editCheck(i.agentId, ctx);
          return check;
        },
        summary: async (i, ctx) => {
          const a = await orElse(
            () => this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId),
            null,
          );
          const n = named(a?.definition.name ?? i.agentId);
          return a?.visibility === "private"
            ? { zh: `删除私有智能体「${n}」`, en: `Delete private agent "${n}"` }
            : { zh: `删除共享智能体「${n}」`, en: `Delete shared agent "${n}"` };
        },
        run: async (input, ctx) => {
          await this.agents.softDelete(
            ctx.orgId,
            input.agentId,
            ctx.actorAccountId,
            undefined,
            viaAgent("agents.delete", ctx),
          );
          return { id: input.agentId, deleted: true };
        },
      }),
      defineOperation({
        id: "agents.versions",
        description:
          "List the versions of an agent you can see, newest first: the version number, who saved it and when. Read the definition of the current one with agents.get.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId/versions"],
        confirm: "read",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; only agents you can see can be read.",
          },
        ],
        run: async (input, ctx) => {
          await this.agents.get(ctx.orgId, input.agentId, ctx.actorAccountId);
          return { versions: await this.agents.listVersions(input.agentId) };
        },
      }),
      defineOperation({
        id: "agents.bind-connector",
        description:
          "Bind one of the org's connectors to a pending connector of an agent (an agent created from a template waits for connectors the org lacked): the agent gets a new version with that connector's tools and the entry is gone. Needs the owner or an org admin; the connector must match the entry's template or protocol and have its tools synced. Read the pending entries from agents.get.",
        input: z
          .object({
            agentId: AgentId,
            key: PendingConnectorParams.shape.key.max(200),
            connectorId: PendingConnectorBindBody.shape.connectorId,
          })
          .strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          key: "crm",
          connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60",
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/:key/bind"],
        confirm: "personal",
        confirmFor: (i, ctx) => this.updateClass(i.agentId, undefined, ctx),
        errors: [
          {
            code: "agent.pending_connector_not_found",
            next: "The agent has no pending connector with this key; read its pending entries with agents.get.",
          },
          {
            code: "agent.pending_connector_mismatch",
            next: "That connector does not fit the entry (another template or protocol, no tools synced yet, or none of the entry's tools); pick another with connectors.list, or ask an org admin to set one up.",
          },
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; only the owner or an org admin can bind.",
          },
        ],
        precheck: async (i, ctx) => {
          const { agent: _a, ...found } = await this.editCheck(i.agentId, ctx);
          if (!found.ok) return found;
          return precheckBy(() =>
            this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId),
          );
        },
        summary: async (i, ctx) => {
          const agent = await this.agentName(ctx, i.agentId);
          const c = named(
            await orElse(
              async () =>
                (await this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)).name,
              i.connectorId,
            ),
          );
          return {
            zh: `把连接器「${c}」绑定到智能体「${agent}」的待配置连接器「${named(i.key)}」，智能体将获得新版本`,
            en: `Bind connector "${c}" to pending connector "${named(i.key)}" of agent "${agent}"; the agent gets a new version`,
          };
        },
        run: async (input, ctx) => {
          const r = await this.pending.bind(
            ctx.orgId,
            input.agentId,
            input.key,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            viaAgent("agents.bind-connector", ctx),
          );
          return {
            agent: brief(r.agent),
            currentVersion: r.agent.currentVersion,
            dropped: r.dropped,
          };
        },
      }),
      defineOperation({
        id: "agents.request-connector-setup",
        description:
          "Send the org admins a request to set up the connectors an agent is still waiting for (the owner or an org admin may). If a request is already pending it is returned instead of a second one. This only asks: the admins decide on the web.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request"],
        confirm: "personal",
        errors: [
          {
            code: "agent.no_pending_connectors",
            next: "The agent waits for no connectors; nothing to request.",
          },
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; only the owner or an org admin can request.",
          },
        ],
        precheck: async (i, ctx) => {
          const { agent, ...check } = await this.editCheck(i.agentId, ctx);
          if (!check.ok || agent === undefined) return check;
          return (agent.definition.pendingConnectors ?? []).length === 0
            ? {
                ok: false,
                code: "agent.no_pending_connectors",
                message: "The agent has no connectors waiting to be configured",
              }
            : { ok: true };
        },
        summary: async (i, ctx) => {
          const n = await this.agentName(ctx, i.agentId);
          return {
            zh: `请求组织管理员为智能体「${n}」配置所缺的连接器`,
            en: `Ask the org admins to set up the connectors agent "${n}" is waiting for`,
          };
        },
        run: async (input, ctx) => {
          const r = await this.pending.reopen(
            ctx.orgId,
            input.agentId,
            ctx.actorAccountId,
            undefined,
            viaAgent("agents.request-connector-setup", ctx),
          );
          return { created: r.created, request: await this.requests.view(r.id) };
        },
      }),
      defineOperation({
        id: "agents.connector-setup-status",
        description:
          "Read the latest connector setup request of an agent, whatever its status (pending, approved, cancelled), or null when none was sent. Only the agent's owner or an org admin may read it.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request"],
        confirm: "read",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list.",
          },
          {
            code: "forbidden",
            next: {
              orgAdmin: "Only the agent's owner or an org admin can read its setup request.",
              member:
                "Only the agent's owner or an org admin can read its setup request; ask one of them.",
            },
          },
        ],
        run: async (input, ctx) => {
          const id = await this.pending.latestRequest(ctx.orgId, input.agentId, ctx.actorAccountId);
          return { request: id === null ? null : await this.requests.view(id) };
        },
      }),
      defineOperation({
        id: "agents.readiness",
        description:
          "Whether the org can run agents: modelProvider is ready when a model provider is available in the org (none otherwise), and how many agents you can see.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/readiness"],
        confirm: "read",
        run: async (_input, ctx) => ({
          modelProvider: (await this.providers.hasProvider(ctx.orgId)) ? "ready" : "none",
          agents: (await this.agents.listVisible(ctx.orgId, ctx.actorAccountId)).length,
        }),
      }),
    ]);
  }
}
