import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type OrgReadiness, ReadinessService } from "./readiness.service.js";

/** Service tokens have no account: they see `visibility='org'` agents only (as the agent list). */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

/**
 * Whether the org can run (`/api/v1/orgs/:orgId/readiness`, web-order spec §3.8): the web app
 * decides between the shell and the setup layout with it. `modelProvider` is `ready` when a
 * model-provider extension is loaded (enabled and configured), from extension state only, never
 * a vendor call; `orgCanAddModel` says whether an org admin can make one usable from the org's
 * 扩展 page (switch on a provider the platform offers, or fill its org config) or only the super
 * admin can; `agents` is the number of agents the caller can see (the agent list's visibility).
 * Humans and service tokens (`org.read`).
 *
 * `modelProvider` counts the deployment's providers whose effective config is valid in this org
 * (spec B §5.5: a provider the platform installed without a key needs each org's own). It is read
 * from this replica's provider registry, which follows the per-replica extension reconcile: right
 * after a provider is enabled, a replica that has not reconciled yet may still answer `none` for
 * a moment.
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
