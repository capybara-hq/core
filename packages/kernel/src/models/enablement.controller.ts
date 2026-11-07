import { Controller, Inject, Put } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type ModelDisableResult, ModelEnablement } from "./enablement.js";

/** `:provider` of a disabled-list route. */
export const ModelProviderParams = z.object({ provider: z.string().min(1).max(200) });
export class ModelProviderParamsDto extends createZodDto(
  ModelProviderParams,
  "ModelProviderParams",
) {}

/** The body of a disabled-list PUT: every disabled model id of the provider (replaces the list). */
export const ModelDisabledPut = z
  .object({ models: z.array(z.string().min(1).max(200)).max(5000) })
  .strict();
export class ModelDisabledPutDto extends createZodDto(ModelDisabledPut, "ModelDisabledPut") {}

/**
 * The org's disabled models of one provider (`PUT /api/v1/orgs/:orgId/models/:provider/disabled`,
 * spec B §5.3): `org.models.manage`, people only. Replaces the org's list for the provider; the
 * response lists the org's agents and purposes that now point at a newly disabled model (the
 * disable is not refused for them).
 */
@Controller("api/v1/orgs/:orgId/models")
export class ModelEnablementController {
  constructor(@Inject(ModelEnablement) private readonly enablement: ModelEnablement) {}

  @Put(":provider/disabled")
  @OrgAction("org.models.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ModelProviderParamsDto) params: z.infer<typeof ModelProviderParams>,
    @ZBody(ModelDisabledPutDto) body: z.infer<typeof ModelDisabledPut>,
  ): Promise<ModelDisableResult> {
    const p = requireUser(principal);
    return this.enablement.setOrg(org.orgId, params.provider, body.models, {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }
}
