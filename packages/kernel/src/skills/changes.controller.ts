import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { AgentsService } from "../agents/agents.service.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { InboxService, type InboxView } from "../inbox/inbox.service.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type SkillChangeDetail,
  SkillChangesService,
  type SkillChangeView,
} from "./changes.service.js";
import { type SkillSummary, SkillsService } from "./skills.service.js";

const DecideBody = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(1000).optional(),
  })
  .strict();
class SkillChangeDecideBody extends createZodDto(DecideBody, "SkillChangeDecideBody") {}

/**
 * 共享 agent 的技能变更申请（`/api/v1/orgs/:orgId/skill-changes`，M5 T15，R4）。动作 `approvals.decide`
 * （访客起、仅限用户主体：agent / 服务令牌不能决定，R2）；能否决定由服务按该 agent **当前的负责人**判定，
 * 其他人 403 `skill_change.not_owner`。详情只给负责人与发起人，其他人 404。
 */
@Controller("api/v1/orgs/:orgId/skill-changes")
export class SkillChangesController {
  constructor(@Inject(SkillChangesService) private readonly changes: SkillChangesService) {}

  @Get(":id")
  @OrgAction("approvals.decide")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ skillChange: SkillChangeDetail }> {
    const p = requireUser(principal);
    return { skillChange: await this.changes.get(org.orgId, id, p.account.id) };
  }

  @Post(":id/decide")
  @HttpCode(200)
  @OrgAction("approvals.decide")
  async decide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZBody(SkillChangeDecideBody) body: z.infer<typeof DecideBody>,
  ): Promise<{ skillChange: SkillChangeView }> {
    const p = requireUser(principal);
    return {
      skillChange: await this.changes.decide(org.orgId, id, p.account.id, body, patTokenId(p)),
    };
  }
}

/**
 * agent 自己的技能（`/api/v1/orgs/:orgId/agents/:agentId/skills`，M5 T15 / T16）：
 * - `GET /`：列表（`scope=agent`、未删除，按名字），与 `GET /agents/:agentId` 同一可见性（`agents.use`；
 *   看不到的 agent → 404 `agent.not_found`；服务令牌只看到 visibility='org' 的 agent）；
 * - `DELETE /:skillId`：软删除，只有该 agent 当前的负责人（其他人 403 `forbidden`），仅限用户主体
 *   （`agents.create` 属 HUMAN_ONLY）。同名的待处理改动一并取消。
 */
@Controller("api/v1/orgs/:orgId/agents/:agentId/skills")
export class AgentSkillsController {
  constructor(
    @Inject(SkillChangesService) private readonly changes: SkillChangesService,
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
    await this.changes.deleteAgentSkill(org.orgId, agentId, skillId, p.account.id, patTokenId(p));
  }
}

/**
 * 收件箱（`GET /api/v1/orgs/:orgId/inbox`，计划取舍 C6：按类型汇总）：当前用户待处理的工具审批与
 * 能决定的技能变更，新的在前、最多 100 项（`truncated` 表示还有更多）。仅限用户主体。
 */
@Controller("api/v1/orgs/:orgId/inbox")
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @Get()
  @OrgAction("approvals.decide")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<InboxView> {
    const p = requireUser(principal);
    return this.inbox.list(org.orgId, p.account.id);
  }
}
