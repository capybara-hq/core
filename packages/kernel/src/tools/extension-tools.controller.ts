import { Controller, Get, Header, Inject } from "@nestjs/common";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type ExtensionToolsOffer, OrgExtensionTools } from "./info.js";

/**
 * `GET /api/v1/orgs/:orgId/tools/extensions` (`agents.use`) → `{ extensions }`: the tools of the
 * extensions enabled in the org, grouped by extension, for the agent form's Tools section (it adds
 * or removes `{kind:"plugin",plugin,name}` references). Display only; nothing here is model-visible.
 */
@Controller("api/v1/orgs/:orgId/tools")
export class ExtensionToolsController {
  constructor(@Inject(OrgExtensionTools) private readonly tools: OrgExtensionTools) {}

  @Get("extensions")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async extensions(@CurrentOrg() org: OrgContext): Promise<{ extensions: ExtensionToolsOffer[] }> {
    return { extensions: await this.tools.list(org.orgId) };
  }
}
