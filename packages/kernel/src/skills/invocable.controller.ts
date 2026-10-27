import { Controller, Get, Header, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { SKILL_INVOKER } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { InvocableSkill, SkillInvoker } from "./invoke.js";

const ListQuery = z.object({ conversationId: z.string().min(1).max(100).optional() }).strict();

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
  constructor(@Inject(SKILL_INVOKER) private readonly invoker: SkillInvoker) {}

  @Get()
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ skills: InvocableSkill[] }> {
    const p = requireUser(principal);
    return {
      skills: await this.invoker.listFor(org.orgId, agentId, p.account.id, q.conversationId),
    };
  }
}
