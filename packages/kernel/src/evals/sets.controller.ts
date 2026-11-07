import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  EvalAddCaseBody as AddCaseBody,
  EvalSetCreateBody as CreateBody,
  EvalSetPatchBody as PatchBody,
  EvalSampleBody as SampleBody,
} from "./evals.schemas.js";
import {
  type EvalCaseDetail,
  type EvalCaseView,
  type EvalSetDetail,
  EvalSetsService,
  type EvalSetView,
} from "./sets.service.js";

class CreateBodyDto extends createZodDto(CreateBody, "EvalSetCreateBody") {}
class PatchBodyDto extends createZodDto(PatchBody, "EvalSetPatchBody") {}
class AddCaseBodyDto extends createZodDto(AddCaseBody, "EvalSetAddCaseBody") {}
class SampleBodyDto extends createZodDto(SampleBody, "EvalSetSampleBody") {}

/**
 * 评测集与用例（`/api/v1/orgs/:orgId/eval-sets`）：全部 `evals.manage`（admin 起、只给人）。
 * 用例详情返回快照还原的轨迹，每次写审计 `trajectory.viewed`。
 */
@Controller("api/v1/orgs/:orgId/eval-sets")
export class EvalSetsController {
  constructor(@Inject(EvalSetsService) private readonly sets: EvalSetsService) {}

  @Post()
  @OrgAction("evals.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(CreateBodyDto) body: z.infer<typeof CreateBody>,
  ): Promise<{ set: EvalSetView }> {
    const p = requireUser(principal);
    const set = await this.sets.create(
      org.orgId,
      p.account.id,
      {
        agentId: body.agentId,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        ...(body.rubric !== undefined && { rubric: body.rubric }),
      },
      patTokenId(p),
    );
    return { set };
  }

  @Get()
  @OrgAction("evals.manage")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ sets: EvalSetView[] }> {
    requireUser(principal);
    return { sets: await this.sets.list(org.orgId) };
  }

  @Get(":setId")
  @OrgAction("evals.manage")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
  ): Promise<{ set: EvalSetDetail }> {
    requireUser(principal);
    return { set: await this.sets.get(org.orgId, setId) };
  }

  @Patch(":setId")
  @OrgAction("evals.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @ZBody(PatchBodyDto) body: z.infer<typeof PatchBody>,
  ): Promise<{ set: EvalSetView }> {
    const p = requireUser(principal);
    const set = await this.sets.update(
      org.orgId,
      p.account.id,
      setId,
      {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.rubric !== undefined && { rubric: body.rubric }),
      },
      patTokenId(p),
    );
    return { set };
  }

  @Delete(":setId")
  @HttpCode(204)
  @OrgAction("evals.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.sets.remove(org.orgId, p.account.id, setId, patTokenId(p));
  }

  @Post(":setId/cases")
  @OrgAction("evals.manage")
  async addCase(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @ZBody(AddCaseBodyDto) body: z.infer<typeof AddCaseBody>,
  ): Promise<{ case: EvalCaseView }> {
    const p = requireUser(principal);
    return { case: await this.sets.addCase(org.orgId, p.account.id, setId, body, patTokenId(p)) };
  }

  @Post(":setId/cases/sample")
  @HttpCode(200)
  @OrgAction("evals.manage")
  async sample(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @ZBody(SampleBodyDto) body: z.infer<typeof SampleBody>,
  ): Promise<{ added: number; skipped: number }> {
    const p = requireUser(principal);
    return this.sets.sample(
      org.orgId,
      p.account.id,
      setId,
      {
        count: body.count,
        ...(body.from !== undefined && { from: body.from }),
        ...(body.to !== undefined && { to: body.to }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.minToolCalls !== undefined && { minToolCalls: body.minToolCalls }),
      },
      patTokenId(p),
    );
  }

  @Get(":setId/cases/:caseId")
  @OrgAction("evals.manage")
  async getCase(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @Param("caseId") caseId: string,
  ): Promise<EvalCaseDetail> {
    const p = requireUser(principal);
    return this.sets.getCase(org.orgId, p.account.id, setId, caseId, patTokenId(p));
  }

  @Delete(":setId/cases/:caseId")
  @HttpCode(204)
  @OrgAction("evals.manage")
  async removeCase(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("setId") setId: string,
    @Param("caseId") caseId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.sets.removeCase(org.orgId, p.account.id, setId, caseId, patTokenId(p));
  }
}
