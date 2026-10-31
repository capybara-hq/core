import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { AgentsService } from "./agents.service.js";

/** Service tokens have no account: they see `visibility='org'` agents only (as the agent list). */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

/**
 * Whether the org can run (`/api/v1/orgs/:orgId/readiness`, web-order spec §3.8): the web app
 * decides between the shell and the setup layout with it. `modelProvider` is `ready` when a
 * model-provider extension is loaded (enabled and configured), from extension state only, never
 * a vendor call; `agents` is the number of agents the caller can see (the agent list's
 * visibility). Humans and service tokens (`org.read`).
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
  ): Promise<{ modelProvider: "ready" | "none"; agents: number }> {
    const visible = await this.agents.listVisible(org.orgId, viewerOf(principal));
    return {
      modelProvider: this.registry.hasProvider() ? "ready" : "none",
      agents: visible.length,
    };
  }
}
