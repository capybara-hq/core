import { Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type EvalEstimate,
  type EvalResultLight,
  type EvalResultView,
  EvalRunsService,
  type EvalRunView,
  type EvalTokenCaps,
} from "./runs.service.js";
import type { EvalCandidate } from "./step-replay.js";

const Candidate = z
  .object({
    agentVersion: z.number().int().min(1).optional(),
    model: ModelRef.strict().optional(),
    modelParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    instructions: z.string().max(100_000).optional(),
  })
  .strict();

/** `tokenCap` 只校验类型，范围由服务判定（`eval.token_cap_invalid`）。 */
const EstimateBody = z
  .object({
    mode: z.enum(["step", "run"]),
    candidate: Candidate,
    judge: z.boolean().default(false),
    tokenCap: z.number().int().optional(),
  })
  .strict();

const StartBody = EstimateBody;

/**
 * `view=light`：不含内容块（结果表与轮询用，响应带 `asOf`）；缺省 `full`。`updatedSince`（ISO 时间）只取之后有变化的，
 * 轮询时传上一次的 `asOf`。
 */
const ResultsQuery = z
  .object({
    after: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    view: z.enum(["full", "light"]).default("full"),
    updatedSince: z
      .string()
      .max(64)
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO timestamp" })
      .optional(),
  })
  .strict();

const LabelBody = z
  .object({
    label: z.enum(["pass", "fail"]).nullable(),
    note: z.string().max(2000).optional(),
  })
  .strict();

/** 去掉 zod 输出里值为 undefined 的键（exactOptionalPropertyTypes）。 */
function candidateOf(c: z.infer<typeof Candidate>): EvalCandidate {
  return {
    ...(c.agentVersion !== undefined && { agentVersion: c.agentVersion }),
    ...(c.model !== undefined && { model: c.model }),
    ...(c.modelParams !== undefined && { modelParams: c.modelParams }),
    ...(c.instructions !== undefined && { instructions: c.instructions }),
  };
}

class EstimateBodyDto extends createZodDto(EstimateBody, "EvalRunEstimateBody") {}
class StartBodyDto extends createZodDto(StartBody, "EvalRunStartBody") {}
class ResultsQueryDto extends createZodDto(ResultsQuery, "EvalRunResultsQuery") {}
class LabelBodyDto extends createZodDto(LabelBody, "EvalRunLabelBody") {}

/**
 * 评测运行（`/api/v1/orgs/:orgId/eval-sets/:setId/runs`、`/api/v1/orgs/:orgId/eval-runs/:runId[/results[/:resultId]]`）与
 * 结果的人工标注（`/api/v1/orgs/:orgId/eval-results/:resultId/label`）：
 * 全部 `evals.manage`（admin 起、只给人）。
 */
@Controller("api/v1/orgs/:orgId")
export class EvalRunsController {
  constructor(@Inject(EvalRunsService) private readonly runs: EvalRunsService) {}

  @Post("eval-sets/:setId/runs/estimate")
  @HttpCode(200)
  @OrgAction("evals.manage")
  async estimate(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @ZBody(EstimateBodyDto) body: z.infer<typeof EstimateBody>,
  ): Promise<{ estimate: EvalEstimate } & EvalTokenCaps> {
    requireUser(principal);
    return this.runs.estimate(org.orgId, setId, {
      mode: body.mode,
      candidate: candidateOf(body.candidate),
      judge: body.judge,
      ...(body.tokenCap !== undefined && { tokenCap: body.tokenCap }),
    });
  }

  @Post("eval-sets/:setId/runs")
  @OrgAction("evals.manage")
  async start(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @ZBody(StartBodyDto) body: z.infer<typeof StartBody>,
  ): Promise<{ run: EvalRunView }> {
    const p = requireUser(principal);
    const run = await this.runs.start(
      org.orgId,
      p.account.id,
      setId,
      {
        mode: body.mode,
        candidate: candidateOf(body.candidate),
        judge: body.judge,
        ...(body.tokenCap !== undefined && { tokenCap: body.tokenCap }),
      },
      patTokenId(p),
    );
    return { run };
  }

  @Get("eval-sets/:setId/runs")
  @OrgAction("evals.manage")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
  ): Promise<{ runs: EvalRunView[] }> {
    requireUser(principal);
    return { runs: await this.runs.listForSet(org.orgId, setId) };
  }

  @Get("eval-runs/:runId")
  @OrgAction("evals.manage")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("runId") runId: string,
  ): Promise<{ run: EvalRunView }> {
    requireUser(principal);
    return { run: await this.runs.get(org.orgId, runId) };
  }

  @Get("eval-runs/:runId/results")
  @OrgAction("evals.manage")
  async results(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("runId") runId: string,
    @ZQuery(ResultsQueryDto) q: z.infer<typeof ResultsQuery>,
  ): Promise<
    | { results: EvalResultView[]; next: string | null }
    | { results: EvalResultLight[]; next: string | null; asOf: string }
  > {
    const p = requireUser(principal);
    const query = {
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
      ...(q.updatedSince !== undefined && { updatedSince: q.updatedSince }),
    };
    return q.view === "light"
      ? this.runs.resultsLight(org.orgId, p.account.id, runId, query, patTokenId(p))
      : this.runs.results(org.orgId, p.account.id, runId, query, patTokenId(p));
  }

  /** 一条结果的完整行（查看器按需读取）。 */
  @Get("eval-runs/:runId/results/:resultId")
  @OrgAction("evals.manage")
  async result(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("runId") runId: string,
    @Param("resultId") resultId: string,
  ): Promise<{ result: EvalResultView }> {
    const p = requireUser(principal);
    return {
      result: await this.runs.result(org.orgId, p.account.id, runId, resultId, patTokenId(p)),
    };
  }

  @Post("eval-runs/:runId/cancel")
  @HttpCode(200)
  @OrgAction("evals.manage")
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("runId") runId: string,
  ): Promise<{ run: EvalRunView }> {
    const p = requireUser(principal);
    return { run: await this.runs.cancel(org.orgId, p.account.id, runId, patTokenId(p)) };
  }

  /** 人工标注一条结果：`label` 为 pass / fail，或 null 清除（备注随之清除）。 */
  @Put("eval-results/:resultId/label")
  @OrgAction("evals.manage")
  async label(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("resultId") resultId: string,
    @ZBody(LabelBodyDto) body: z.infer<typeof LabelBody>,
  ): Promise<{ result: EvalResultView }> {
    const p = requireUser(principal);
    const result = await this.runs.label(
      org.orgId,
      p.account.id,
      resultId,
      { label: body.label, ...(body.note !== undefined && { note: body.note }) },
      patTokenId(p),
    );
    return { result };
  }
}
