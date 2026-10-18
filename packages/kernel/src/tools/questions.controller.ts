import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { QUESTIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { QuestionsService, QuestionView } from "./questions.service.js";

/** 回答体：`answer` 的形状由服务按表单校验（`validateAnswer`，不符 → `validation_failed`）。 */
const AnswerBody = z.object({ answer: z.record(z.string().max(200), z.unknown()) }).strict();

/**
 * 输入请求（`ask_user`、插件工具的 `input_required`）：`/api/v1/orgs/:orgId/questions`。
 * 动作用 `approvals.decide`（访客起、仅限用户主体）：回答必须由人做出，agent / 服务令牌不能代答；
 * 具体是否允许由服务判定——只有该运行的发起人能读取与回答，其他成员 403。
 */
@Controller("api/v1/orgs/:orgId/questions")
export class QuestionsController {
  constructor(@Inject(QUESTIONS) private readonly questions: QuestionsService) {}

  @Get(":id")
  @OrgAction("approvals.decide")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ question: QuestionView }> {
    const p = requireUser(principal);
    return { question: await this.questions.get(org.orgId, id, p.account.id) };
  }

  @Post(":id/answer")
  @HttpCode(200)
  @OrgAction("approvals.decide")
  async answer(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Body(new ZodPipe(AnswerBody)) body: z.infer<typeof AnswerBody>,
  ): Promise<{ question: QuestionView }> {
    const p = requireUser(principal);
    const { state: _state, ...view } = await this.questions.answer(
      id,
      p.account.id,
      body.answer,
      org.orgId,
    );
    return { question: view };
  }
}
