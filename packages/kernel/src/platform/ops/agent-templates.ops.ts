import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AgentsService } from "../../agents/agents.service.js";
import { OrgAgentTemplates } from "../../agents/org-templates.js";
import { AgentTemplatesService } from "../../agents/templates.js";
import {
  AgentTemplateIdParams,
  AgentTemplateShareableBody,
  AgentTemplateUpdateBody,
  SaveAsAgentIdParams,
  SaveAsTemplateBody,
} from "../../agents/templates.schemas.js";
import { OwnedItems } from "../../catalog/owned-items.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const TemplateId = AgentTemplateIdParams.shape.id;

/** Agent template operations of the `Platform` tool (spec §7). */
@Injectable()
export class AgentTemplatesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AgentTemplatesService) private readonly templates: AgentTemplatesService,
    @Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

  private templateName(ctx: OperationContext, id: string): Promise<string> {
    return orElse(async () => named((await this.orgTemplates.detail(ctx.orgId, id)).name), id);
  }

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
          "Read one agent template with its definition (model tier, tools, the skills an agent made from it loads first, the skills it turns off (disallowedSkills), connectors it needs). Takes the template id from agent-templates.list.",
        input: z.object({ templateId: AgentTemplateIdParams.shape.id }).strict(),
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10" },
        authz: { orgAction: "agents.create" },
        mirrors: ["GET /api/v1/orgs/:orgId/agent-templates/:id"],
        renames: { templateId: "id" },
        confirm: "read",
        run: async (input, ctx) => ({
          template: await this.orgTemplates.detail(ctx.orgId, input.templateId),
        }),
      }),
      defineOperation({
        id: "agent-templates.save",
        description:
          "Save an agent of the org as an org agent template under a new name, so members can create their own copy from it. The skills the agent turns off are saved as the template's disallowedSkills. Credentials and per-person settings are not carried over; the result lists what was omitted.",
        input: SaveAsAgentIdParams.extend({
          name: SaveAsTemplateBody.shape.name.min(1).max(80),
          description: SaveAsTemplateBody.shape.description.max(1024),
        }).strict(),
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
          this.orgTemplates.saveAs(
            ctx.orgId,
            ctx.actorAccountId,
            input.agentId,
            { name: input.name, description: input.description },
            undefined,
            viaAgent("agent-templates.save", ctx),
          ),
      }),
      defineOperation({
        id: "agent-templates.update",
        description:
          "Save a new version of an org agent template (org admins): send the whole definition as agent-templates.get returned it, changed as wanted, and the version you read. The name cannot change. Agents already created from the template keep their definition. A version that is no longer current is refused: read the template again first.",
        input: z
          .object({
            templateId: TemplateId,
            version: AgentTemplateUpdateBody.shape.expectedVersion,
            definition: z
              .record(z.string().max(200), z.unknown())
              .refine((v) => JSON.stringify(v).length <= 500_000, {
                message: "The definition is too large",
              }),
          })
          .strict(),
        example: {
          templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10",
          version: 2,
          definition: { name: "support-triage", description: "Triages support requests." },
        },
        authz: { orgAction: "agents.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/agent-templates/:id"],
        renames: { templateId: "id", version: "expectedVersion" },
        confirm: "org",
        errors: [
          {
            code: "agent_template.version_conflict",
            next: "The template changed since you read it: read it again with agent-templates.get, then send its current version.",
          },
          {
            code: "catalog.not_owned",
            next: "Only an agent template the org created can be changed here; a plugin's template or a copy of another owner's is not the org's to change.",
          },
          {
            code: "component.not_found",
            next: "Check the template id with agent-templates.list; this org cannot use that template.",
          },
          {
            code: "validation_failed",
            next: "The definition is not a valid agent template, or its name changed; fix it as the message says.",
          },
        ],
        precheck: async (i, ctx) => {
          const found = await precheckBy(() => this.orgTemplates.detail(ctx.orgId, i.templateId));
          if (!found.ok) return found;
          const t = await this.orgTemplates.detail(ctx.orgId, i.templateId);
          return t.owned
            ? { ok: true }
            : {
                ok: false,
                code: "catalog.not_owned",
                message: "The org does not own this template",
              };
        },
        summary: async (i, ctx) => {
          const n = await this.templateName(ctx, i.templateId);
          return {
            zh: `保存组织智能体模板「${n}」的新版本（基于版本 ${i.version}）`,
            en: `Save a new version of org agent template "${n}" (from version ${i.version})`,
          };
        },
        run: async (input, ctx) => ({
          template: await this.orgTemplates.update(
            ctx.orgId,
            ctx.actorAccountId,
            input.templateId,
            { definition: input.definition, expectedVersion: input.version },
            undefined,
            viaAgent("agent-templates.update", ctx),
          ),
        }),
      }),
      defineOperation({
        id: "agent-templates.delete-preview",
        description:
          "Preview deleting an org agent template (org admins): whether it is removed or handed to the platform because another org uses it, and which of the org's agents were created from it. Show it to the person before agent-templates.delete.",
        input: z.object({ templateId: TemplateId }).strict(),
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10" },
        authz: { orgAction: "agents.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/agent-templates/:id/delete-preview"],
        renames: { templateId: "id" },
        confirm: "read",
        errors: [
          {
            code: "catalog.not_owned",
            next: "Only an agent template the org created can be changed here; a plugin's template or a copy of another owner's is not the org's to change.",
          },
          {
            code: "component.not_found",
            next: "Check the template id with agent-templates.list; this org cannot use that template.",
          },
        ],
        run: async (input, ctx) => ({
          preview: await this.owned.previewAgentTemplateDelete(ctx.orgId, input.templateId),
        }),
      }),
      defineOperation({
        id: "agent-templates.delete",
        description:
          "Delete an org agent template (org admins). A template another org uses is handed to the platform instead of removed; agents created from it keep working. Read agent-templates.delete-preview first and show it to the person.",
        input: z.object({ templateId: TemplateId }).strict(),
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10" },
        authz: { orgAction: "agents.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/agent-templates/:id"],
        renames: { templateId: "id" },
        confirm: "org",
        errors: [
          {
            code: "catalog.not_owned",
            next: "Only an agent template the org created can be changed here; a plugin's template or a copy of another owner's is not the org's to change.",
          },
          {
            code: "component.not_found",
            next: "Check the template id with agent-templates.list; this org cannot use that template.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.owned.previewAgentTemplateDelete(ctx.orgId, i.templateId)),
        summary: async (i, ctx) => {
          const n = await this.templateName(ctx, i.templateId);
          const p = await orElse(
            () => this.owned.previewAgentTemplateDelete(ctx.orgId, i.templateId),
            null,
          );
          const handed = p?.outcome === "transferred";
          return {
            zh: `删除组织智能体模板「${n}」${handed ? "；其他组织在用，将转为平台模板" : ""}`,
            en: `Delete org agent template "${n}"${handed ? "; another org uses it, so it becomes a platform template" : ""}`,
          };
        },
        run: async (input, ctx) => ({
          id: input.templateId,
          outcome: await this.owned.deleteAgentTemplate(
            ctx.orgId,
            ctx.actorAccountId,
            input.templateId,
            { auditDetail: viaAgent("agent-templates.delete", ctx) },
          ),
        }),
      }),
      defineOperation({
        id: "agent-templates.set-shareable",
        description:
          "Set whether an org agent template may be shared with other orgs (org admins). Only the org's own templates can be changed; a plugin's template cannot.",
        input: z
          .object({ templateId: TemplateId, shareable: AgentTemplateShareableBody.shape.shareable })
          .strict(),
        example: { templateId: "5d0c7a52-3a0e-4f0a-bd0a-0f8c3d2a9e10", shareable: true },
        authz: { orgAction: "agents.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/agent-templates/:id/shareable"],
        renames: { templateId: "id" },
        confirm: "org",
        errors: [
          {
            code: "catalog.not_owned",
            next: "Only an agent template the org created can be changed here; a plugin's template or a copy of another owner's is not the org's to change.",
          },
          {
            code: "component.not_found",
            next: "Check the template id with agent-templates.list; this org cannot use that template.",
          },
        ],
        precheck: async (i, ctx) => {
          const found = await precheckBy(() => this.orgTemplates.detail(ctx.orgId, i.templateId));
          if (!found.ok) return found;
          const t = await this.orgTemplates.detail(ctx.orgId, i.templateId);
          return t.owned
            ? { ok: true }
            : {
                ok: false,
                code: "catalog.not_owned",
                message: "The org does not own this template",
              };
        },
        summary: async (i, ctx) => {
          const n = await this.templateName(ctx, i.templateId);
          return i.shareable
            ? {
                zh: `允许把组织智能体模板「${n}」共享给其他组织`,
                en: `Allow org agent template "${n}" to be shared with other orgs`,
              }
            : {
                zh: `不再把组织智能体模板「${n}」共享给其他组织`,
                en: `Stop sharing org agent template "${n}" with other orgs`,
              };
        },
        run: async (input, ctx) => {
          await this.owned.setShareable(
            ctx.orgId,
            ctx.actorAccountId,
            { kind: "agent_template", id: input.templateId },
            input.shareable,
            { auditDetail: viaAgent("agent-templates.set-shareable", ctx) },
          );
          return { id: input.templateId, shareable: input.shareable };
        },
      }),
    ]);
  }
}
