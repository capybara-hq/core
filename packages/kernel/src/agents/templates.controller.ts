import { Controller, Delete, Get, Inject, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { OwnedItems, type OwnedSkillDeletePreview } from "../catalog/owned-items.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type AgentTemplateDetail,
  OrgAgentTemplates,
  type SaveAsOmission,
} from "./org-templates.js";
import { AgentTemplatesService, type AgentTemplateView } from "./templates.js";
import {
  AgentTemplateIdParams,
  SaveAsAgentIdParams,
  SaveAsTemplateBody,
} from "./templates.schemas.js";

const ShareableBody = z.object({ shareable: z.boolean() }).strict();
const UpdateBody = z
  .object({
    /** The whole definition (the `AgentTemplate` shape), validated like a template file. */
    definition: z.record(z.string(), z.unknown()),
    /** The `version` the editor read; another one -> 409 `agent_template.version_conflict`. */
    expectedVersion: z.number().int().min(1),
  })
  .strict();
class AgentTemplateIdParamsDto extends createZodDto(
  AgentTemplateIdParams,
  "AgentTemplateIdParams",
) {}
class SaveAsAgentIdParamsDto extends createZodDto(SaveAsAgentIdParams, "SaveAsAgentIdParams") {}
class AgentTemplateShareableBody extends createZodDto(
  ShareableBody,
  "AgentTemplateShareableBody",
) {}
class SaveAsTemplateBodyDto extends createZodDto(SaveAsTemplateBody, "SaveAsTemplateBody") {}
class AgentTemplateUpdateBody extends createZodDto(UpdateBody, "AgentTemplateUpdateBody") {}

const actorOpts = (p: ReturnType<typeof requireUser>) => {
  const tokenId = patTokenId(p);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * The org's agent templates (`/api/v1/orgs/:orgId/agent-templates`, phase C spec §17; plugin scope
 * phase 4, rulings P4-9 to P4-13). Reads with `agents.create` (members, people only): the list
 * the agent editor and the 模板 tab show, and one template's detail with its definition. The org's
 * own templates (saved from an agent, `POST orgs/:orgId/agents/:agentId/save-as-template`) are
 * edited, deleted and made 可共享 by the owner org's admins (`agents.manage`, the action that
 * manages agent templates).
 */
@Controller("api/v1/orgs/:orgId/agent-templates")
export class AgentTemplatesController {
  constructor(
    @Inject(AgentTemplatesService) private readonly templates: AgentTemplatesService,
    @Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

  @Get()
  @OrgAction("agents.create")
  async list(@CurrentOrg() org: OrgContext): Promise<{ templates: AgentTemplateView[] }> {
    return { templates: await this.templates.listForOrg(org.orgId) };
  }

  /**
   * One template usable in the org (an org template, a linked copy, a platform template on in
   * the org) with its definition, owner and the org's flags (`owned`, `shareable`, `promoted`).
   * Not usable here -> 404 `component.not_found`.
   */
  @Get(":id")
  @OrgAction("agents.create")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParamsDto) params: z.infer<typeof AgentTemplateIdParams>,
  ): Promise<{ template: AgentTemplateDetail }> {
    requireUser(principal);
    return { template: await this.orgTemplates.detail(org.orgId, params.id) };
  }

  /**
   * A new version of the org's own template (ruling P4-12): `{ definition, expectedVersion }` ->
   * 200 `{ template }`; a stale version -> 409 `agent_template.version_conflict`; a template the
   * org does not own -> 409 `catalog.not_owned`.
   */
  @Put(":id")
  @OrgAction("agents.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParamsDto) params: z.infer<typeof AgentTemplateIdParams>,
    @ZBody(AgentTemplateUpdateBody) body: z.infer<typeof UpdateBody>,
  ): Promise<{ template: AgentTemplateDetail }> {
    const p = requireUser(principal);
    const template = await this.orgTemplates.update(
      org.orgId,
      p.account.id,
      params.id,
      body,
      patTokenId(p),
    );
    return { template };
  }

  /**
   * What deleting the org's own template does (nothing written): `outcome` `transferred` when it
   * was shared and another org uses it (`orgs`), else `removed`; `agents` the org's agents whose
   * roster loses it.
   */
  @Get(":id/delete-preview")
  @OrgAction("agents.manage")
  async deletePreview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParamsDto) params: z.infer<typeof AgentTemplateIdParams>,
  ): Promise<OwnedSkillDeletePreview> {
    requireUser(principal);
    return this.owned.previewAgentTemplateDelete(org.orgId, params.id);
  }

  /**
   * Deletes the org's own template (the P3 owner rules, ruling P4-12): one it shared that another
   * org uses becomes the platform's (platform notice `ownership_transferred`). 200 `{ outcome }`.
   */
  @Delete(":id")
  @OrgAction("agents.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParamsDto) params: z.infer<typeof AgentTemplateIdParams>,
  ): Promise<{ outcome: "transferred" | "removed" }> {
    const p = requireUser(principal);
    const outcome = await this.owned.deleteAgentTemplate(
      org.orgId,
      p.account.id,
      params.id,
      actorOpts(p),
    );
    return { outcome };
  }

  /**
   * Sets 可共享 on the org's own agent template (`{ shareable }` -> 200 `{ id, shareable }`; an org
   * template, ruling P4-13): a plugin's template or a copy of another owner's platform template
   * -> 409 `catalog.not_owned`; one the org promoted writes its platform row too (ruling P3-2).
   */
  @Put(":id/shareable")
  @OrgAction("agents.manage")
  async setShareable(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParamsDto) params: z.infer<typeof AgentTemplateIdParams>,
    @ZBody(AgentTemplateShareableBody) body: z.infer<typeof ShareableBody>,
  ): Promise<{ id: string; shareable: boolean }> {
    const p = requireUser(principal);
    await this.owned.setShareable(
      org.orgId,
      p.account.id,
      { kind: "agent_template", id: params.id },
      body.shareable,
      actorOpts(p),
    );
    return { id: params.id, shareable: body.shareable };
  }
}

/**
 * 另存为模板 (ruling P4-9; `agents.manage`, org admins): `POST
 * /api/v1/orgs/:orgId/agents/:agentId/save-as-template { name, description }` -> 201
 * `{ template, omitted }`. `template` is the new org template's detail (version 1, the bare
 * `name`); `omitted` lists what the template leaves out (`SaveAsOmission`: allowlisted org agents
 * in the roster, the agent's own skills, connectors and sub-agents no longer usable, entries past
 * a limit). A name the org can already use as a type -> 409 `agent_template.name_taken` (details
 * `[{ owner, templateId }]`). Its own controller: the agents controller is the agent CRUD.
 */
@Controller("api/v1/orgs/:orgId/agents")
export class AgentSaveAsTemplateController {
  constructor(@Inject(OrgAgentTemplates) private readonly orgTemplates: OrgAgentTemplates) {}

  @Post(":agentId/save-as-template")
  @OrgAction("agents.manage")
  async saveAs(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SaveAsAgentIdParamsDto) params: z.infer<typeof SaveAsAgentIdParams>,
    @ZBody(SaveAsTemplateBodyDto) body: z.infer<typeof SaveAsTemplateBody>,
  ): Promise<{ template: AgentTemplateDetail; omitted: SaveAsOmission[] }> {
    const p = requireUser(principal);
    return this.orgTemplates.saveAs(org.orgId, p.account.id, params.agentId, body, patTokenId(p));
  }
}
