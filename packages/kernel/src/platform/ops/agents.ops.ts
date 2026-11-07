import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { AgentView } from "../../agents/agent-lookup.js";
import {
  AgentCreateBody,
  AgentCreateDefinition,
  AgentFromTemplateBody,
  AgentFromTemplatePreviewBody,
  AgentPathParams,
  AgentUpdateBody,
} from "../../agents/agents.schemas.js";
import { AgentsService } from "../../agents/agents.service.js";
import {
  AgentDefinitionSchema,
  AgentToolRefCurrent,
  DEFAULT_AGENT_TOOLS,
  type ModelRef,
} from "../../agents/definition.js";
import { AgentsFromTemplate } from "../../agents/from-template.service.js";
import { OrgAgentTemplates } from "../../agents/org-templates.js";
import { type ConfirmClass, defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const AgentId = AgentPathParams.shape.agentId.max(100);
/** The request's definition (create form): the operations tighten its fields, never redeclare them. */
const Def = AgentCreateDefinition.shape;
/** Every string the model sends is bounded (the route's tool refs and model strings are not). */
const Short = z.string().min(1).max(200);

const Model = Def.model.extend({ provider: Short, model: Short }).strict();
const [BuiltinRef, PluginRef, ConnectorRef] = AgentToolRefCurrent.options;
const ToolRef = z.union([
  BuiltinRef.extend({ name: Short }).strict(),
  PluginRef.extend({ plugin: Short, name: Short }).strict(),
  ConnectorRef.extend({
    connectorId: Short,
    tools: z.union([z.literal("all"), z.array(Short).min(1).max(200)]),
  }).strict(),
]);
const RouteSkills = Def.skills.unwrap();
/** `writePolicy` stays the web's; `orgSkills` is required here (the route defaults it to []). */
const Skills = RouteSkills.pick({ pinned: true })
  .extend({ orgSkills: RouteSkills.shape.orgSkills.unwrap() })
  .strict();

/** The definition fields an agent can set through the tool; the rest keep the web's defaults. */
const Fields = {
  name: Def.name,
  instructions: Def.instructions.unwrap(),
  model: Model,
  tools: z.array(ToolRef).max(200),
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
    @Inject(AgentsFromTemplate) private readonly fromTemplate: AgentsFromTemplate,
    @Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates,
  ) {}

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
          "Read one agent you can see with its full definition: instructions, model, tools, skills and sub-agents. Takes the agent id from agents.list.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId"],
        confirm: "read",
        run: async (input, ctx) =>
          asToolError(async () => ({
            agent: await this.agents.get(ctx.orgId, input.agentId, ctx.actorAccountId),
          })),
      }),
      defineOperation({
        id: "agents.create",
        description:
          "Create a new private agent owned by you, with a name, a model and optionally instructions, tools, skills and sub-agents. Without tools it gets the default ones. Agents created with the Platform tool are private; sharing an agent with the org or with members is done on the agents page of the web app.",
        input: z
          .object({
            definition: z
              .object({
                name: Fields.name,
                instructions: Fields.instructions.optional(),
                model: Fields.model,
                tools: Fields.tools.optional(),
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
            tools: d.tools ?? structuredClone(DEFAULT_AGENT_TOOLS),
            ...(d.toolPolicies !== undefined && { toolPolicies: d.toolPolicies }),
            ...(d.skills !== undefined && { skills: d.skills }),
            ...(d.subagents !== undefined && { subagents: d.subagents }),
          });
          return asToolError(() =>
            this.agents.create(
              ctx.orgId,
              ctx.actorAccountId,
              {
                definition: { ...parsed, instructions: d.instructions },
                visibility: "private",
              },
              undefined,
              viaAgent("agents.create", ctx),
            ),
          );
        },
      }),
      defineOperation({
        id: "agents.update",
        description:
          "Change an agent you may edit: your own, private or shared, and as an org admin any agent of the org. Send the version you read from agents.get and only the fields to change; the others keep their value. A version that is no longer current is refused, so read the agent again first. The visibility cannot be changed here (that is done on the agents page of the web app). A change to your own private agent may be remembered by the person; a change to a shared agent is confirmed every time.",
        input: z
          .object({
            agentId: AgentId,
            version: AgentUpdateBody.shape.expectedVersion.unwrap(),
            name: Fields.name.optional(),
            instructions: Fields.instructions.optional(),
            model: Fields.model.optional(),
            tools: Fields.tools.optional(),
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
          instructions: "definition.instructions",
          model: "definition.model",
          tools: "definition.tools",
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
        run: async (input, ctx) =>
          asToolError(async () => {
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
              ...(patch.instructions !== undefined && { instructions: patch.instructions }),
              ...(patch.model !== undefined && { model: patch.model as ModelRef }),
              ...(patch.tools !== undefined && { tools: patch.tools }),
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
          }),
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
        run: async (input, ctx) =>
          asToolError(() => this.fromTemplate.preview(ctx.orgId, input.templateId)),
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
        ],
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
          return asToolError(() =>
            this.fromTemplate.create(
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
            ),
          );
        },
      }),
    ]);
  }
}
