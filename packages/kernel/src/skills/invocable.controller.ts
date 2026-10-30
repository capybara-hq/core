import { Controller, Get, Header, Inject, Param } from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type InvocableSkill, SkillInvoker } from "./invoke.js";

const ListQuery = z.object({ conversationId: z.string().min(1).max(100).optional() }).strict();
class InvocableSkillsQuery extends createZodDto(ListQuery, "InvocableSkillsQuery") {}

/**
 * The composer's `/` menu (phase D spec §4.5): `GET /api/v1/orgs/:orgId/agents/:agentId/
 * invocable-skills?conversationId=` lists the agent's effective skills a person can invoke, sorted
 * by name. Agent-scoped because a conversation is created on its first send. People only
 * (`agents.use`, human principals: invocations are sent from a conversation); an agent the caller
 * cannot use → 404 `agent.not_found`; a `conversationId` that is not the caller's conversation with
 * this agent → 404 `conversation.not_found` (with it, that conversation's trial drafts apply).
 */
@Controller("api/v1/orgs/:orgId/agents/:agentId/invocable-skills")
export class InvocableSkillsController {
  constructor(@Inject(SkillInvoker) private readonly invoker: SkillInvoker) {}

  @Get()
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZQuery(InvocableSkillsQuery) q: z.infer<typeof ListQuery>,
  ): Promise<{ skills: InvocableSkill[] }> {
    const p = requireUser(principal);
    return {
      skills: await this.invoker.listFor(org.orgId, agentId, p.account.id, q.conversationId),
    };
  }
}
