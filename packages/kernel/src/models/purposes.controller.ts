import { Body, Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { MODEL_PURPOSES } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type ModelPurposesService,
  PURPOSE_PUT,
  type PurposePut,
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
  constructor(@Inject(MODEL_PURPOSES) private readonly purposes: ModelPurposesService) {}

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
    @Body(new ZodPipe(PURPOSE_PUT)) body: PurposePut,
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
