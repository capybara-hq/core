import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { AgentsService } from "./agents.service.js";
import { type OrgReadiness, orgReadiness } from "./readiness.js";

/** Service tokens have no account: they see `visibility='org'` agents only (as the agent list). */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

/**
 * Whether the org can run (`/api/v1/orgs/:orgId/readiness`, web-order spec §3.8): the web app
 * decides between the shell and the setup layout with it. `modelProvider` ({@link OrgReadiness})
 * is `ready` when a model-provider extension is loaded (enabled and configured) and enabled in
 * the org, `not_enabled` when loaded providers are only waiting for the org to enable one, from
 * extension state only, never a vendor call; `agents` is the number of agents the caller can see (the agent list's
 * visibility). Humans and service tokens (`org.read`).
 *
 * `modelProvider` counts the deployment's providers whose effective config is valid in this org
 * (spec B §5.5: a provider the platform installed without a key needs each org's own). It is read
 * from this replica's provider registry, which follows the per-replica extension reconcile: right
 * after a provider is enabled, a replica that has not reconciled yet may still answer `none` for
 * a moment.
 */
@Controller("api/v1/orgs/:orgId/readiness")
export class ReadinessController {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}

  @Get()
  @OrgAction("org.read")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<OrgReadiness> {
    const visible = await this.agents.listVisible(org.orgId, viewerOf(principal));
    return orgReadiness(await this.registry.readiness(org.orgId), visible.length);
  }
}
