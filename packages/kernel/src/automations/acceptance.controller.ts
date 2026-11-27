import { Controller, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type AutomationAcceptanceBody,
  AutomationAcceptanceBodyDto,
  type AutomationAcceptanceQuery,
  AutomationAcceptanceQueryDto,
  type AutomationOfferParams,
  AutomationOfferParamsDto,
} from "./automations.schemas.js";
import { type AcceptanceRulesView, AcceptanceService } from "./events/acceptance.js";

/**
 * Directed events and acceptance (`/api/v1/orgs/:orgId/automations`, collaboration spec §4.4);
 * human users only (a service token gets 403), each acting on their own rules and offers only:
 * - `GET /acceptance` → `{ items, directedDefault }`: the caller's rule per trigger source that
 *   assigns work (has directed event types), null where they follow the org's default;
 * - `PUT /acceptance { rules }` → the same: sets (or, with `mode: null`, removes) the caller's
 *   rules;
 * - `POST /offers/:id/accept` → `{ automationId }`: the caller accepts their own work offer, the
 *   acceptance automation runs the work;
 * - `POST /offers/:id/decline` → 204: the caller declines it, the person who caused it is told.
 *
 * Another person's offer is 404 `automation.offer_not_found` (org admins included). The org's
 * default is an org setting (`automations.directedDefault`, the org settings route).
 */
@Controller("api/v1/orgs/:orgId/automations")
export class AcceptanceController {
  constructor(@Inject(AcceptanceService) private readonly acceptance: AcceptanceService) {}

  @Get("acceptance")
  @OrgAction("automations.use")
  async rules(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(AutomationAcceptanceQueryDto) _q: z.infer<typeof AutomationAcceptanceQuery>,
  ): Promise<AcceptanceRulesView> {
    const p = requireUser(principal);
    return this.acceptance.rules(org.orgId, p.account.id);
  }

  @Put("acceptance")
  @OrgAction("automations.use")
  async setRules(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(AutomationAcceptanceBodyDto) body: z.infer<typeof AutomationAcceptanceBody>,
  ): Promise<AcceptanceRulesView> {
    const p = requireUser(principal);
    return this.acceptance.setRules(org.orgId, p.account.id, body.rules);
  }

  @Post("offers/:id/accept")
  @OrgAction("automations.use")
  @HttpCode(200)
  async accept(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AutomationOfferParamsDto) params: z.infer<typeof AutomationOfferParams>,
  ): Promise<{ automationId: string }> {
    const p = requireUser(principal);
    return this.acceptance.accept(org.orgId, p.account.id, params.id);
  }

  // org.read: a person demoted to guest may still decline what was offered to them
  @Post("offers/:id/decline")
  @OrgAction("org.read")
  @HttpCode(204)
  async decline(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AutomationOfferParamsDto) params: z.infer<typeof AutomationOfferParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.acceptance.decline(org.orgId, p.account.id, params.id);
  }
}
