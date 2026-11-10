import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { z } from "zod";
import { AgentsService } from "../agents/agents.service.js";
import type { CreatedAttachment } from "../conversations/attachments.service.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AgentSkillsService, type RegisterOutcome } from "./agent-skills.service.js";
import { AgentSkillRegisterBody, AgentSkillUploadBody } from "./skills.schemas.js";
import { type SkillSummary, SkillsService } from "./skills.service.js";

class AgentSkillUploadBodyDto extends createZodDto(AgentSkillUploadBody, "AgentSkillUploadBody") {}
class AgentSkillRegisterBodyDto extends createZodDto(
  AgentSkillRegisterBody,
  "AgentSkillRegisterBody",
) {}

/**
 * An agent's own skills (`/api/v1/orgs/:orgId/agents/:agentId/skills`):
 * - `GET /`: the list (`scope = agent`, live, by name), with the visibility of
 *   `GET /agents/:agentId` (`agents.use`; an agent not visible -> 404 `agent.not_found`; a service
 *   token sees only `visibility = 'org'` agents);
 * - the writes are `agents.create` (HUMAN_ONLY) and only for the agent's current owner (others 403
 *   `forbidden`, checked in the service):
 *   1. `POST /uploads` `{ name, size }` registers a skill package upload (`application/zip`,
 *      <= 50 MB, a presigned form as for org skills); agent skills are not governed by the
 *      deployment's `customSkills` setting;
 *   2. the browser uploads straight to object storage;
 *   3. `POST /` `{ uploadId }` unpacks and checks it, creating the agent's skill or its next
 *      version (200 `{ skill }`; the upload is consumed);
 *   `DELETE /:skillId` soft-deletes one (a pending change of the same name is cancelled with it).
 */
@Controller("api/v1/orgs/:orgId/agents/:agentId/skills")
export class AgentSkillsController {
  constructor(
    @Inject(AgentSkillsService) private readonly agentSkills: AgentSkillsService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {}

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ skills: SkillSummary[] }> {
    await this.agents.get(
      org.orgId,
      agentId,
      principal.kind === "user" ? principal.account.id : null,
    );
    return { skills: await this.skills.listForAgent(org.orgId, agentId) };
  }

  @Post("uploads")
  @OrgAction("agents.create")
  async createUpload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentSkillUploadBodyDto) body: z.infer<typeof AgentSkillUploadBody>,
  ): Promise<CreatedAttachment> {
    const p = requireUser(principal);
    return this.skills.createAgentUpload(org.orgId, p.account.id, agentId, body);
  }

  @Post()
  @HttpCode(200)
  @OrgAction("agents.create")
  async register(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentSkillRegisterBodyDto) body: z.infer<typeof AgentSkillRegisterBody>,
  ): Promise<{ skill: RegisterOutcome }> {
    const p = requireUser(principal);
    return {
      skill: await this.skills.registerAgentUpload(
        org.orgId,
        p.account.id,
        agentId,
        body.uploadId,
        patTokenId(p),
      ),
    };
  }

  @Delete(":skillId")
  @HttpCode(204)
  @OrgAction("agents.create")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Param("skillId") skillId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.agentSkills.deleteAgentSkill(
      org.orgId,
      agentId,
      skillId,
      p.account.id,
      patTokenId(p),
    );
  }
}
