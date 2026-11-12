import { Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { InboxNoticeParams } from "../inbox/inbox.schemas.js";
import { InboxService, type InboxView } from "../inbox/inbox.service.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type SkillChangeDetail,
  SkillChangesService,
  type SkillChangeView,
} from "./changes.service.js";

const DecideBody = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(1000).optional(),
  })
  .strict();
class SkillChangeDecideBody extends createZodDto(DecideBody, "SkillChangeDecideBody") {}

const NoticeParamsSchema = InboxNoticeParams;
class NoticeParams extends createZodDto(NoticeParamsSchema, "InboxNoticeParams") {}

/**
 * Skill change requests (`/api/v1/orgs/:orgId/skill-changes`): sharing an agent skill with the org
 * and version proposals on a shared skill (spec §5.4, §5.5), user principals only (agents and
 * service tokens never decide). `GET /:id` is `approvals.decide`; the service shows it to org
 * admins and the requester only, anyone else 404. `POST /:id/decide` is `skills.manage` (org
 * admins; the service re-checks the role live under the org row lock).
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
  @OrgAction("skills.manage")
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
 * 收件箱（`GET /api/v1/orgs/:orgId/inbox`，计划取舍 C6：按类型汇总）：当前用户待处理的工具审批与
 * 能决定的技能变更，新的在前、最多 100 项（`truncated` 表示还有更多）。仅限用户主体。
 * Org admins also see the org's open notices and dismiss them with
 * `POST /api/v1/orgs/:orgId/inbox/notices/:id/dismiss`.
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

  /** An org admin dismisses an org notice -> 204. */
  @Post("notices/:id/dismiss")
  @HttpCode(204)
  @OrgAction("approvals.decide")
  async dismissNotice(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(NoticeParams) params: z.infer<typeof NoticeParamsSchema>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.inbox.dismissNotice(org.orgId, p.account.id, params.id);
  }
}
