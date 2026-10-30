import { Controller, Get, Inject, Param, Put } from "@nestjs/common";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  ModelPurposesService,
  type PurposePut,
  PurposePutDto,
  type PurposeTarget,
  type PurposeView,
} from "./purposes.js";

/** body 的目标（参数缺省为 `{}`）。 */
export const purposeTargetOf = (b: PurposePut): PurposeTarget | null =>
  b.target === null ? null : { model: b.target.model, params: b.target.params ?? {} };

/**
 * 本组织的模型用途映射（`/api/v1/orgs/:orgId/model-purposes`）：`org.models.manage`（admin 起、只给人）。
 * 列表给出每个用途的部署默认、组织覆盖与生效的映射；PUT 设置或（`target: null`）清除组织覆盖。
 */
@Controller("api/v1/orgs/:orgId/model-purposes")
export class ModelPurposesController {
  constructor(@Inject(ModelPurposesService) private readonly purposes: ModelPurposesService) {}

  @Get()
  @OrgAction("org.models.manage")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ purposes: PurposeView[] }> {
    requireUser(principal);
    return { purposes: await this.purposes.list(org.orgId) };
  }

  @Put(":purpose")
  @OrgAction("org.models.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("purpose") purpose: string,
    @ZBody(PurposePutDto) body: PurposePut,
  ): Promise<{ purpose: PurposeView }> {
    const p = requireUser(principal);
    return {
      purpose: await this.purposes.setOrg(
        org.orgId,
        purpose,
        purposeTargetOf(body),
        p.account.id,
        patTokenId(p),
      ),
    };
  }
}
