import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { APPROVALS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { CONTROL_OR_HIDDEN_RE } from "../text.js";
import {
  APPROVAL_DENY_REASON_MAX_CHARS,
  type ApprovalRecord,
  type ApprovalsService,
  type ApprovalView,
  type ToolGrantView,
} from "./approvals.service.js";

const ListQuery = z
  .object({ status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).optional() })
  .strict();

const DecisionBody = z
  .object({
    decision: z.enum(["approve", "deny"]),
    scope: z.enum(["once", "session", "always"]).optional(),
    note: z.string().max(1000).optional(),
    /** Only with `deny`: passed to the model with the denied call's result. */
    // no control characters but newline and tab, and no format characters (bidi, invisible; ZWNJ
    // and ZWJ allowed): the title rule (final review m1; PG also rejects NUL)
    reason: z
      .string()
      .trim()
      .min(1)
      .max(APPROVAL_DENY_REASON_MAX_CHARS)
      .refine(
        (r) => !CONTROL_OR_HIDDEN_RE.test(r.replace(/[\n\t]/g, " ")),
        "reason must not contain control or format characters",
      )
      .optional(),
  })
  .strict()
  .refine((b) => b.reason === undefined || b.decision === "deny", {
    path: ["reason"],
    message: "A reason can only be given with deny",
  });

/**
 * 工具调用审批（`/api/v1/orgs/:orgId/approvals`，`approvals.decide`：访客起、仅限用户主体——agent 不能审批，R2）。
 * 能否看到 / 处理某条审批由 `requested_for` / `approver_role` 判定（见 `ApprovalsService`），看不到的一律 404。
 */
@Controller("api/v1/orgs/:orgId/approvals")
export class ApprovalsController {
  constructor(@Inject(APPROVALS) private readonly approvals: ApprovalsService) {}

  @Get()
  @OrgAction("approvals.decide")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ approvals: ApprovalView[] }> {
    const p = requireUser(principal);
    return { approvals: await this.approvals.list(org.orgId, p.account.id, q.status) };
  }

  @Get(":id")
  @OrgAction("approvals.decide")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ approval: ApprovalView }> {
    const p = requireUser(principal);
    return { approval: await this.approvals.get(org.orgId, id, p.account.id) };
  }

  @Post(":id/decision")
  @HttpCode(200)
  @OrgAction("approvals.decide")
  async decide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Body(new ZodPipe(DecisionBody)) body: z.infer<typeof DecisionBody>,
  ): Promise<{ approval: ApprovalRecord }> {
    const p = requireUser(principal);
    return {
      approval: await this.approvals.decide(org.orgId, id, p.account.id, body, patTokenId(p)),
    };
  }
}

/** 本人的「以后都允许」授权（`/api/v1/orgs/:orgId/me/tool-grants`）：查看与撤销，只动自己的。 */
@Controller("api/v1/orgs/:orgId/me/tool-grants")
export class ToolGrantsController {
  constructor(@Inject(APPROVALS) private readonly approvals: ApprovalsService) {}

  @Get()
  @OrgAction("approvals.decide")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ grants: ToolGrantView[] }> {
    const p = requireUser(principal);
    return { grants: await this.approvals.listGrants(org.orgId, p.account.id) };
  }

  @Delete(":agentId/:toolKey")
  @HttpCode(204)
  @OrgAction("approvals.decide")
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Param("toolKey") toolKey: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.approvals.revokeGrant(org.orgId, p.account.id, agentId, toolKey, patTokenId(p));
  }
}
