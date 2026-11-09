import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { Throttled } from "../infra/throttler/throttler.guard.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { SetupCheckState } from "./setup-check-registry.js";
import {
  SetupCheckPathParams,
  SetupCheckRunBody,
  SetupChecksQuery,
  SetupGuidePathParams,
} from "./setup-checks.schemas.js";
import { SetupChecksService } from "./setup-checks.service.js";

class SetupGuideParamsDto extends createZodDto(SetupGuidePathParams, "SetupGuidePathParams") {}
class SetupCheckParamsDto extends createZodDto(SetupCheckPathParams, "SetupCheckPathParams") {}
class SetupChecksQueryDto extends createZodDto(SetupChecksQuery, "SetupChecksQuery") {}
class SetupCheckRunBodyDto extends createZodDto(SetupCheckRunBody, "SetupCheckRunBody") {}

/**
 * The live rows of a setup guide (spec 2026-11-09-setup-guides-v2-design.md §10.3). Authorization
 * is the guide route's (`catalog.read` here; catalog visibility, the place and audience action
 * and the target are checked by the service before anything is loaded). A response carries only
 * the fixed fields of {@link SetupCheckState}.
 */
@Controller("api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks")
export class SetupChecksController {
  constructor(@Inject(SetupChecksService) private readonly checks: SetupChecksService) {}

  /** The cached state of each check of the rendered guide; never runs anything. */
  @Get()
  @OrgAction("catalog.read")
  async states(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SetupGuideParamsDto) params: z.infer<typeof SetupGuidePathParams>,
    @ZQuery(SetupChecksQueryDto) q: z.infer<typeof SetupChecksQuery>,
  ): Promise<{ results: Record<string, SetupCheckState> }> {
    const p = requireUser(principal);
    return {
      results: await this.checks.states(
        { orgId: org.orgId, role: org.role, accountId: p.account.id },
        params.itemId,
        params.guideId,
        q,
      ),
    };
  }

  /**
   * Runs one check unless a fresh result is cached (`force`: rerun, once per 10 s per check and
   * target). 30 runs a minute per account (429 `rate_limited`): counted by the service, shared
   * with the `Platform` tool's `setup.check`; the throttler also guards the route (`retry-after`).
   */
  @Post(":checkId/run")
  @HttpCode(200)
  @OrgAction("catalog.read")
  @Throttled("setup-check")
  async run(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SetupCheckParamsDto) params: z.infer<typeof SetupCheckPathParams>,
    @ZBody(SetupCheckRunBodyDto) body: z.infer<typeof SetupCheckRunBody>,
  ): Promise<{ result: SetupCheckState }> {
    const p = requireUser(principal);
    return {
      result: await this.checks.run(
        { orgId: org.orgId, role: org.role, accountId: p.account.id },
        params.itemId,
        params.guideId,
        params.checkId,
        body,
      ),
    };
  }
}
