import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type OrgReadiness, ReadinessService } from "./readiness.service.js";

/** Service tokens have no account: they see `visibility='org'` agents only (as the agent list). */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

/**
 * Whether the org can run (`/api/v1/orgs/:orgId/readiness`, web-order spec §3.8): the web app
 * decides between the shell and the setup layout with it ({@link OrgReadiness}: `ready`,
 * `org_fixable` with the providers an org admin can switch on or configure, or `none`; and the
 * agents the caller can see). Computed by {@link ReadinessService}, from extension state only,
 * never a vendor call. Humans and service tokens (`org.read`).
 */
@Controller("api/v1/orgs/:orgId/readiness")
export class ReadinessController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get()
  @OrgAction("org.read")
  get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<OrgReadiness> {
    return this.readiness.get(org.orgId, viewerOf(principal));
  }
}
