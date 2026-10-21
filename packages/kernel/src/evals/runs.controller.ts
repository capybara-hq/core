import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import { EVAL_RUNS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { EvalEstimate, EvalResultView, EvalRunsService, EvalRunView } from "./runs.service.js";
import type { EvalCandidate } from "./step-replay.js";

const Candidate = z
  .object({
    agentVersion: z.number().int().min(1).optional(),
    model: ModelRef.strict().optional(),
    modelParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    instructions: z.string().max(100_000).optional(),
  })
  .strict();

const EstimateBody = z
  .object({
    mode: z.enum(["step", "run"]),
    candidate: Candidate,
    judge: z.boolean().default(false),
  })
  .strict();

/** `tokenCap` 只校验类型，范围由服务判定（`eval.token_cap_invalid`）。 */
const StartBody = EstimateBody.extend({ tokenCap: z.number().int().optional() }).strict();

const ResultsQuery = z
  .object({
    after: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
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

/**
 * 评测运行（`/api/v1/orgs/:orgId/eval-sets/:setId/runs`、`/api/v1/orgs/:orgId/eval-runs/:runId`）：
 * 全部 `evals.manage`（admin 起、只给人）。
 */
@Controller("api/v1/orgs/:orgId")
export class EvalRunsController {
  constructor(@Inject(EVAL_RUNS) private readonly runs: EvalRunsService) {}

  @Post("eval-sets/:setId/runs/estimate")
  @HttpCode(200)
  @OrgAction("evals.manage")
  async estimate(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @Body(new ZodPipe(EstimateBody)) body: z.infer<typeof EstimateBody>,
  ): Promise<{ estimate: EvalEstimate }> {
    requireUser(principal);
    const estimate = await this.runs.estimate(org.orgId, setId, {
      mode: body.mode,
      candidate: candidateOf(body.candidate),
      judge: body.judge,
    });
    return { estimate };
  }

  @Post("eval-sets/:setId/runs")
  @OrgAction("evals.manage")
  async start(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>,
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
    @Query(new ZodPipe(ResultsQuery)) q: z.infer<typeof ResultsQuery>,
  ): Promise<{ results: EvalResultView[]; next: string | null }> {
    requireUser(principal);
    return this.runs.results(org.orgId, runId, {
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
    });
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
}
