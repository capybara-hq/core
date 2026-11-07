import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AgentsService } from "../../agents/agents.service.js";
import { OrgAgentTemplates } from "../../agents/org-templates.js";
import { AgentTemplatesService } from "../../agents/templates.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

/** Agent template operations of the `Platform` tool (spec §7). */
@Injectable()
export class AgentTemplatesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AgentTemplatesService) private readonly templates: AgentTemplatesService,
    @Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "agent-templates.list",
        description:
          "List the agent templates usable in the org, the org's own and platform templates switched on in it. Each entry has an id, name, description and version; create an agent from one with agents.create-from-template.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "agents.create" },
        mirrors: ["GET /api/v1/orgs/:orgId/agent-templates"],
        confirm: "read",
        run: async (_input, ctx) => ({ templates: await this.templates.listForOrg(ctx.orgId) }),
      }),
      defineOperation({
        id: "agent-templates.get",
        description:
          "Read one agent template with its definition (model tier, tools, skills, connectors it needs). Takes the template id from agent-templates.list.",
        input: z.object({ templateId: z.string().min(1).max(100) }).strict(),
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10" },
        authz: { orgAction: "agents.create" },
        mirrors: ["GET /api/v1/orgs/:orgId/agent-templates/:id"],
        confirm: "read",
        run: async (input, ctx) =>
          asToolError(async () => ({
            template: await this.orgTemplates.detail(ctx.orgId, input.templateId),
          })),
      }),
      defineOperation({
        id: "agent-templates.save",
        description:
          "Save an agent of the org as an org agent template under a new name, so members can create their own copy from it. Credentials and per-person settings are not carried over; the result lists what was omitted.",
        input: z
          .object({
            agentId: z.string().min(1).max(100),
            name: z.string().min(1).max(80),
            description: z.string().min(1).max(1024),
          })
          .strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          name: "support-triage",
          description: "Triages incoming support requests and drafts a first reply.",
        },
        authz: { orgAction: "agents.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/save-as-template"],
        confirm: "org",
        summary: async (i, ctx) => {
          const source = named(
            await orElse(
              async () =>
                (await this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId)).definition.name,
              i.agentId,
            ),
          );
          return {
            zh: `把智能体「${source}」另存为组织模板「${named(i.name)}」`,
            en: `Save agent "${source}" as org template "${named(i.name)}"`,
          };
        },
        run: async (input, ctx) =>
          asToolError(() =>
            this.orgTemplates.saveAs(
              ctx.orgId,
              ctx.actorAccountId,
              input.agentId,
              { name: input.name, description: input.description },
              undefined,
              viaAgent("agent-templates.save", ctx),
            ),
          ),
      }),
    ]);
  }
}
