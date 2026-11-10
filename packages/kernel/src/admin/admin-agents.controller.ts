import { Controller, Delete, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { type AdminAgentDetail, type AdminAgentRow, AdminAgents } from "../agents/admin-agents.js";
import { AgentsService } from "../agents/agents.service.js";
import { CurrentPrincipal, type Principal, SuperAdmin } from "../identity/principal.js";
import { writeActorOf } from "../identity/write-actor.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { AdminAgentListQuery, AgentIdParams, OwnerBody } from "./admin-items.schemas.js";

class AdminAgentListQueryDto extends createZodDto(AdminAgentListQuery, "AdminAgentListQuery") {}
class AdminAgentIdParamsDto extends createZodDto(AgentIdParams, "AdminAgentIdParams") {}
class AdminOwnerBodyDto extends createZodDto(OwnerBody, "AdminAgentOwnerBody") {}

/**
 * Every org's agents for the super admin (admin agents and connectors spec §4.1): read any agent,
 * transfer its owner, delete it. The super admin need not be a member of the agent's org; each
 * write is audited in that org with `detail.via = "platform"`.
 */
@Controller("api/v1/admin/agents")
@SuperAdmin()
export class AdminAgentsController {
  constructor(
    @Inject(AdminAgents) private readonly admin: AdminAgents,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}

  /** Live agents of live orgs by id; `next` is the `after` of the next page, null at the end. */
  @Get()
  list(
    @ZQuery(AdminAgentListQueryDto) q: z.infer<typeof AdminAgentListQuery>,
  ): Promise<{ agents: AdminAgentRow[]; next: string | null }> {
    return this.admin.list(q);
  }

  @Get(":agentId")
  async get(
    @ZParam(AdminAgentIdParamsDto) { agentId }: z.infer<typeof AgentIdParams>,
  ): Promise<{ agent: AdminAgentDetail }> {
    return { agent: await this.admin.get(agentId) };
  }

  /** Gives the agent to another member of its org; clears `needsReassignment`. */
  @Post(":agentId/owner")
  @HttpCode(200)
  async transfer(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminAgentIdParamsDto) { agentId }: z.infer<typeof AgentIdParams>,
    @ZBody(AdminOwnerBodyDto) body: z.infer<typeof OwnerBody>,
  ): Promise<{ agent: AdminAgentDetail }> {
    await this.agents.reassignOwnerAsPlatform(agentId, body.accountId, writeActorOf(principal));
    return { agent: await this.admin.get(agentId) };
  }

  @Delete(":agentId")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminAgentIdParamsDto) { agentId }: z.infer<typeof AgentIdParams>,
  ): Promise<void> {
    await this.agents.softDeleteAsPlatform(agentId, writeActorOf(principal));
  }
}
