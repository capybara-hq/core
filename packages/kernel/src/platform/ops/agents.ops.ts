import { extensionToolKey, ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { AgentView } from "../../agents/agent-lookup.js";
import { AgentsService } from "../../agents/agents.service.js";
import {
  AgentDefinitionSchema,
  DEFAULT_AGENT_TOOLS,
  type ModelRef,
  SubagentsSchema,
} from "../../agents/definition.js";
import { AgentsFromTemplate } from "../../agents/from-template.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";

const Id = z.string().min(1).max(100);
const Short = z.string().min(1).max(200);

const Model = z.object({ provider: Short, model: Short }).strict();
const ToolRef = z.union([
  z.object({ kind: z.literal("builtin"), name: Short }).strict(),
  z.object({ kind: z.literal("plugin"), plugin: Short, name: Short }).strict(),
  z
    .object({
      kind: z.literal("connector"),
      connectorId: Short,
      tools: z.union([z.literal("all"), z.array(Short).min(1).max(200)]),
    })
    .strict(),
]);
const ToolPolicies = z.record(Short, z.enum(["ask", "deny"]));
const Skills = z
  .object({
    orgSkills: z.array(Id).max(100),
    pinned: z.array(Id).max(100).optional(),
  })
  .strict();

/** The definition fields an agent can set through the tool; the rest keep the web's defaults. */
const Fields = {
  instructions: z.string().max(100_000),
  model: Model,
  tools: z.array(ToolRef).max(200),
  toolPolicies: ToolPolicies,
  skills: Skills,
  subagents: SubagentsSchema,
};

const WEB_ONLY =
  "Only private agents can be created or changed with the Platform tool; sharing an agent with the org or with members is done on the agents page of the web app.";

const keyOf = (r: AgentView["definition"]["tools"][number]): string =>
  r.kind === "builtin"
    ? r.name
    : r.kind === "plugin"
      ? extensionToolKey(r.plugin, r.name)
      : `connector:${r.connectorId}`;

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
  ) {}

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
        input: z.object({ agentId: Id }).strict(),
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
          "Create a new private agent owned by you, with a name, a model and optionally instructions, tools, skills and sub-agents. Without tools it gets the default ones. Only private agents can be created or changed with the Platform tool; sharing an agent with the org or with members is done on the agents page of the web app.",
        input: z
          .object({
            definition: z
              .object({
                name: z.string().min(1).max(80),
                instructions: Fields.instructions.optional(),
                model: Fields.model,
                tools: Fields.tools.optional(),
                toolPolicies: Fields.toolPolicies.optional(),
                skills: Fields.skills.optional(),
                subagents: Fields.subagents.optional(),
              })
              .strict(),
            visibility: z.string().max(40).optional(),
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
          "Change an agent you own (an org admin may change any): send the version you read from agents.get and only the fields to change; the others keep their value. A version that is no longer current is refused, so read the agent again first. Only private agents can be created or changed with the Platform tool; sharing an agent with the org or with members is done on the agents page of the web app.",
        input: z
          .object({
            agentId: Id,
            version: z.number().int().positive(),
            name: z.string().min(1).max(80).optional(),
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
        confirm: "personal",
        summary: (i) => ({
          zh: `修改智能体 ${i.agentId}（版本 ${i.version}）`,
          en: `Update agent ${i.agentId} (version ${i.version})`,
        }),
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
        input: z.object({ templateId: Id }).strict(),
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
          "Create a private agent from an agent template, with the previewHash of agents.preview-from-template; a changed template or org makes the hash stale and the preview must be redone. Connectors the template needs that the org lacks become pending entries and a setup request goes to the org admins. Only private agents can be created or changed with the Platform tool; sharing an agent with the org or with members is done on the agents page of the web app.",
        input: z
          .object({
            templateId: Id,
            name: z.string().min(1).max(80),
            previewHash: z.string().min(1).max(100),
            model: Model.optional(),
            visibility: z.string().max(40).optional(),
          })
          .strict(),
        example: {
          templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10",
          name: "My triage agent",
          previewHash: `${"0".repeat(64)}.${"0".repeat(16)}`,
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/from-template"],
        confirm: "personal",
        summary: (i) => ({
          zh: `从模板新建私有智能体「${i.name}」`,
          en: `Create private agent "${i.name}" from a template`,
        }),
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

export { keyOf as agentToolKey };
