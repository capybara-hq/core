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
  PresetAvatar,
} from "../../agents/agents.schemas.js";
import { AgentsService } from "../../agents/agents.service.js";
import { AgentDefinitionSchema, type ModelRef } from "../../agents/definition.js";
import { AgentsFromTemplate } from "../../agents/from-template.service.js";
import { OrgAgentTemplates } from "../../agents/org-templates.js";
import { PendingConnectorsService } from "../../agents/pending-connectors.service.js";
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
const RouteSkills = Def.skills.unwrap();
/** `writePolicy` stays the web's; `orgSkills` is required here (the route defaults it to []). */
const Skills = RouteSkills.pick({ pinned: true })
  .extend({ orgSkills: RouteSkills.shape.orgSkills.unwrap() })
  .strict();

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
  skills: Skills,
  subagents: Def.subagents.unwrap(),
};

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
  private async updateClass(agentId: string, ctx: OperationContext): Promise<ConfirmClass> {
    const a = await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId);
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
          "Read one agent you can see with its full definition (description, instructions, model, the tools it turns off (disabledTools: an agent has every tool the org offers except these), tool policies, skills and sub-agents) and its profile: the description shown on its cards, the avatar, the quick actions and profile.updatedAt, which agents.update-profile needs. Takes the agent id from agents.list.",
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
          'Create a new private agent owned by you, with a name, a model and optionally instructions, disabledTools, tool policies, skills and sub-agents. An agent has every tool the org offers (all built-in tools, the tools of the extensions on in the org and of the org\'s connectors) unless disabledTools turns it off: { kind: "builtin", name }, { kind: "plugin", plugin, tools: "all" | [names] } or { kind: "connector", connectorId, tools: "all" | [names] }. Agents created with the Platform tool are private; sharing an agent with the org or with members is done on the agents page of the web app.',
        input: z
          .object({
            definition: z
              .object({
                name: Fields.name,
                instructions: Fields.instructions.optional(),
                model: Fields.model,
                disabledTools: Fields.disabledTools.optional(),
                toolPolicies: Fields.toolPolicies.optional(),
                skills: Fields.skills.optional(),
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
            ...(d.skills !== undefined && { skills: d.skills }),
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
          'Change an agent you may edit: your own, private or shared, and as an org admin any agent of the org. Send the version you read from agents.get and only the fields to change; the others keep their value. The description (one short paragraph, "" removes it) is saved with the definition; the avatar and quick actions are changed with agents.update-profile. disabledTools replaces the whole list of turned-off tools (send [] to turn every tool on). A version that is no longer current is refused, so read the agent again first. The visibility cannot be changed here (that is done on the agents page of the web app). A change to your own private agent may be remembered by the person; a change to a shared agent is confirmed every time.',
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
            skills: Fields.skills.optional(),
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
          skills: "definition.skills",
          subagents: "definition.subagents",
        },
        confirm: "personal",
        errors: [
          {
            code: "agent.version_conflict",
            next: "The agent changed since you read it: read it again with agents.get, then send its current version.",
          },
        ],
        confirmFor: (i, ctx) => this.updateClass(i.agentId, ctx),
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
            ...(patch.skills !== undefined && { skills: patch.skills }),
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
          'Change the profile of an agent you may edit (your own, and as an org admin any agent of the org): its quick actions and its avatar. Quick actions are the ready-made prompts offered when a conversation with the agent starts, at most 9, each a title and a body; the list replaces the whole set (send [] to remove them all). The avatar is one of the built-in presets: { kind: "preset", id }. Send profile.updatedAt as read from agents.get (or platform.me for this agent) and only the fields to change; a profile changed since is refused, so read it again first. The description is part of the definition: change it with agents.update. A custom avatar image is uploaded on the agent page of the web app. A change to your own private agent may be remembered by the person; a change to a shared agent is confirmed every time.',
        input: z
          .object({
            agentId: AgentId,
            updatedAt: AgentProfileBody.shape.expectedUpdatedAt,
            avatar: PresetAvatar.optional(),
            quickActions: AgentProfileBody.shape.quickActions,
          })
          .strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          updatedAt: "2026-11-08T09:30:00.000Z",
          avatar: { kind: "preset", id: "fox" },
          quickActions: [
            { title: "Weekly report", body: "Write this week's report from the notes I paste." },
          ],
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/agents/:agentId/profile"],
        // `updatedAt` is the route's `expectedUpdatedAt`; the avatar is a preset only (an upload is
        // the web's, its bytes go through a presigned upload)
        renames: { updatedAt: "expectedUpdatedAt" },
        confirm: "personal",
        confirmFor: (i, ctx) => this.updateClass(i.agentId, ctx),
        errors: [
          {
            code: "agent.profile_conflict",
            next: "The profile changed since you read it: read the agent again with agents.get (or platform.me for this agent) and send its current profile.updatedAt.",
          },
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; only agents you can see can be changed.",
          },
          {
            code: "forbidden",
            next: {
              orgAdmin: "Only the agent's owner or an org admin can change its profile.",
              member:
                "Only the agent's owner or an org admin can change its profile; ask one of them, or change one of your own agents.",
            },
          },
        ],
        precheck: async (i, ctx) => {
          const { agent, ...check } = await this.editCheck(i.agentId, ctx);
          if (!check.ok || agent === undefined) return check;
          return agent.profile.updatedAt === i.updatedAt
            ? { ok: true }
            : {
                ok: false,
                code: "agent.profile_conflict",
                message: `The profile was changed since you read it (now updatedAt ${agent.profile.updatedAt})`,
              };
        },
        summary: async (i, ctx) => {
          const a = await this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId);
          const name = named(a.definition.name);
          const zh: string[] = [];
          const en: string[] = [];
          if (i.avatar !== undefined) {
            zh.push(`头像换成预设「${i.avatar.id}」`);
            en.push(`avatar to preset "${i.avatar.id}"`);
          }
          if (i.quickActions !== undefined) {
            zh.push(`快捷操作设为 ${i.quickActions.length} 个`);
            en.push(`${i.quickActions.length} quick action(s)`);
          }
          const which = a.visibility === "private" ? ["私有", "private"] : ["共享", "shared"];
          return {
            zh: `修改${which[0]}智能体「${name}」的资料${zh.length > 0 ? `：${zh.join("，")}` : ""}`,
            en: `Update the profile of ${which[1]} agent "${name}"${en.length > 0 ? `: ${en.join(", ")}` : ""}`,
          };
        },
        run: async (input, ctx) => {
          const { agentId, updatedAt, ...patch } = input;
          return {
            profile: await this.profiles.update(
              ctx.orgId,
              agentId,
              ctx.actorAccountId,
              {
                ...(patch.avatar !== undefined && { avatar: patch.avatar }),
                ...(patch.quickActions !== undefined && { quickActions: patch.quickActions }),
              },
              updatedAt,
              undefined,
              viaAgent("agents.update-profile", ctx),
            ),
          };
        },
      }),
      defineOperation({
        id: "agents.preview-from-template",
        description:
          "Preview creating an agent from an agent template: what carries over, what is pending (connectors the org has not set up) or unavailable, the model that would be used, and a previewHash. agents.create-from-template needs that hash.",
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
        confirmFor: (i, ctx) => this.updateClass(i.agentId, ctx),
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
        confirmFor: (i, ctx) => this.updateClass(i.agentId, ctx),
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
