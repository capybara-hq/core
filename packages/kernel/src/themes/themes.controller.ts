import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type OrgThemes, ThemesService } from "./themes.service.js";

/** The org's themes (`/api/v1/orgs/:orgId/themes`, themes spec §9): members only. */
@Controller("api/v1/orgs/:orgId/themes")
export class OrgThemesController {
  constructor(@Inject(ThemesService) private readonly themes: ThemesService) {}

  /**
   * `{ themes, resolved, org }`: the themes on in the org (with swatches), the viewer's resolved
   * theme (null: the built-in one) and the org's default and personal lock.
   */
  @Get()
  @OrgAction("org.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<OrgThemes> {
    return this.themes.forOrg(org.orgId, principal.kind === "user" ? principal.account.id : null);
  }
}
