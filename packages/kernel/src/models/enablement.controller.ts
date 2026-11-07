import { Controller, Inject, Patch } from "@nestjs/common";
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

const modelIds = z.array(z.string().min(1).max(200)).max(5000).default([]);

/**
 * The body of a disabled-list PATCH: the model ids of the provider to disable and to enable. An id
 * in neither list keeps its stored state (a page never drops ids it does not show); an id in both
 * is a 400 `validation_failed`.
 */
export const ModelDisabledPatch = z
  .object({ disable: modelIds, enable: modelIds })
  .strict()
  .superRefine((v, ctx) => {
    const disable = new Set(v.disable);
    const both = [...new Set(v.enable.filter((m) => disable.has(m)))];
    if (both.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["enable"],
        message: `A model cannot be both disabled and enabled: ${both.join(", ")}`,
      });
    }
  });
export class ModelDisabledPatchDto extends createZodDto(ModelDisabledPatch, "ModelDisabledPatch") {}

/**
 * The org's disabled models of one provider (`PATCH /api/v1/orgs/:orgId/models/:provider/disabled`,
 * spec B §5.3): `org.models.manage`, people only. Disables and enables the ids the body names; the
 * response lists the org's agents and purposes that now point at a newly disabled model (the
 * disable is not refused for them).
 */
@Controller("api/v1/orgs/:orgId/models")
export class ModelEnablementController {
  constructor(@Inject(ModelEnablement) private readonly enablement: ModelEnablement) {}

  @Patch(":provider/disabled")
  @OrgAction("org.models.manage")
  async patch(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ModelProviderParamsDto) params: z.infer<typeof ModelProviderParams>,
    @ZBody(ModelDisabledPatchDto) body: z.infer<typeof ModelDisabledPatch>,
  ): Promise<ModelDisableResult> {
    const p = requireUser(principal);
    return this.enablement.setOrg(org.orgId, params.provider, body, {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }
}
